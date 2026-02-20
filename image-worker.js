/**
 * image-worker.js — Web Worker for off-main-thread image processing
 *
 * Responsibilities:
 *  1. Parse raw image bytes to extract EXIF GPS lat/lon + capture timestamp
 *  2. Strip ALL EXIF data (privacy protection)
 *  3. Compress image to ≤ 300 KB using OffscreenCanvas + iterative quality stepping
 *  4. Post progress updates { type:'progress', pct } during processing
 *  5. Post final result { type:'done', blob, originalSize, compressedSize, gpsLat, gpsLon, captureTimestamp }
 *
 * Message in: { imageFile: File }
 */

self.onmessage = async (evt) => {
    const { imageFile } = evt.data;

    try {
        // ── Step 1: Read raw bytes ──────────────────────────────────────────
        postProgress(5);
        const arrayBuffer = await imageFile.arrayBuffer();
        const originalSize = arrayBuffer.byteLength;

        // ── Step 2: Extract EXIF metadata (GPS + datetime) ──────────────────
        postProgress(15);
        const exifData = parseExif(arrayBuffer);

        // ── Step 3: Create a Blob URL from the raw file for rendering ───────
        postProgress(25);
        const rawBlob = new Blob([arrayBuffer], { type: imageFile.type });
        const imageBitmap = await createImageBitmap(rawBlob);
        postProgress(40);

        // ── Step 4: Render onto OffscreenCanvas (EXIF-stripped) ─────────────
        // By drawing to canvas we inherently strip ALL EXIF — the canvas only
        // knows pixels, no metadata.
        const MAX_DIM = 1920;
        let { width, height } = imageBitmap;
        if (width > MAX_DIM || height > MAX_DIM) {
            const scale = Math.min(MAX_DIM / width, MAX_DIM / height);
            width = Math.round(width * scale);
            height = Math.round(height * scale);
        }

        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(imageBitmap, 0, 0, width, height);
        imageBitmap.close();
        postProgress(55);

        // ── Step 5: Iterative compression to hit ≤ 300 KB ───────────────────
        const TARGET_BYTES = 300 * 1024; // 300 KB
        let quality = 0.82;
        let compressedBlob;

        for (let attempt = 0; attempt < 8; attempt++) {
            compressedBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
            postProgress(55 + attempt * 5);

            if (compressedBlob.size <= TARGET_BYTES || quality <= 0.25) break;
            // Reduce quality proportionally so we converge quickly
            quality = quality * Math.sqrt(TARGET_BYTES / compressedBlob.size);
            quality = Math.max(0.2, Math.min(quality, 0.95));
        }

        postProgress(95);

        // ── Step 6: Build digital signature from EXIF data ──────────────────
        const signature = buildSignature(exifData);

        postProgress(100);

        // ── Step 7: Post result ──────────────────────────────────────────────
        self.postMessage({
            type: 'done',
            blob: compressedBlob,
            originalSize,
            compressedSize: compressedBlob.size,
            gpsLat: signature.lat,
            gpsLon: signature.lon,
            captureTimestamp: signature.timestamp,
        });

    } catch (err) {
        self.postMessage({ type: 'error', message: err.message });
    }
};

/* ════════════════════════════════════════════
   EXIF Parser — pure bitwise, zero dependencies
   Handles JFIF JPEG with standard APP1 marker
   ════════════════════════════════════════════ */

function parseExif(buffer) {
    const view = new DataView(buffer);
    const result = { lat: null, lon: null, timestamp: null };

    // Must start with JPEG SOI marker 0xFFD8
    if (view.getUint16(0) !== 0xFFD8) return result;

    let offset = 2;

    while (offset < view.byteLength - 4) {
        const marker = view.getUint16(offset);
        offset += 2;

        if (marker === 0xFFE1) {
            // APP1 segment — likely EXIF
            const segLen = view.getUint16(offset);
            offset += 2;

            // Check for "Exif\0\0" header (6 bytes)
            const exifMagic = getString(view, offset, 6);
            if (exifMagic === 'Exif\0\0') {
                const tiffStart = offset + 6;
                parseIFD(view, tiffStart, result);
            }
            offset += segLen - 2;
        } else if ((marker & 0xFF00) === 0xFF00) {
            // Skip other markers
            const segLen = view.getUint16(offset);
            offset += segLen;
        } else {
            break;
        }
    }

    return result;
}

function parseIFD(view, tiffStart, result) {
    // TIFF header: byte order
    const byteOrderMark = view.getUint16(tiffStart);
    const littleEndian = byteOrderMark === 0x4949; // "II"

    const ifdOffset = view.getUint32(tiffStart + 4, littleEndian);
    readIFDEntries(view, tiffStart, tiffStart + ifdOffset, littleEndian, result);
}

function readIFDEntries(view, tiffStart, ifdOffset, le, result) {
    if (ifdOffset + 2 > view.byteLength) return;

    const entryCount = view.getUint16(ifdOffset, le);
    const ENTRY_SIZE = 12;

    for (let i = 0; i < entryCount; i++) {
        const entryBase = ifdOffset + 2 + i * ENTRY_SIZE;
        if (entryBase + ENTRY_SIZE > view.byteLength) break;

        const tag = view.getUint16(entryBase, le);
        const type = view.getUint16(entryBase + 2, le);
        const count = view.getUint32(entryBase + 4, le);
        const valOffset = view.getUint32(entryBase + 8, le);

        // 0x8769 = ExifIFD pointer
        if (tag === 0x8769) {
            readIFDEntries(view, tiffStart, tiffStart + valOffset, le, result);
        }
        // 0x8825 = GPS IFD pointer
        if (tag === 0x8825) {
            readGPSIFD(view, tiffStart, tiffStart + valOffset, le, result);
        }
        // 0x9003 = DateTimeOriginal (ASCII)
        if (tag === 0x9003 && type === 2) {
            const strOffset = count <= 4 ? entryBase + 8 : tiffStart + valOffset;
            result.timestamp = getString(view, strOffset, count - 1).trim();
        }
        // 0x0132 = DateTime (fallback)
        if (tag === 0x0132 && !result.timestamp && type === 2) {
            const strOffset = count <= 4 ? entryBase + 8 : tiffStart + valOffset;
            result.timestamp = getString(view, strOffset, count - 1).trim();
        }
    }
}

function readGPSIFD(view, tiffStart, gpsOffset, le, result) {
    if (gpsOffset + 2 > view.byteLength) return;

    const entryCount = view.getUint16(gpsOffset, le);
    const ENTRY_SIZE = 12;

    let latRef = 'N', lonRef = 'E';
    let latDMS = null, lonDMS = null;

    for (let i = 0; i < entryCount; i++) {
        const entryBase = gpsOffset + 2 + i * ENTRY_SIZE;
        if (entryBase + ENTRY_SIZE > view.byteLength) break;

        const tag = view.getUint16(entryBase, le);
        const type = view.getUint16(entryBase + 2, le);
        const count = view.getUint32(entryBase + 4, le);
        const valField = view.getUint32(entryBase + 8, le);

        // 0x0001 = GPSLatitudeRef, 0x0003 = GPSLongitudeRef
        if (tag === 0x0001 || tag === 0x0003) {
            const ref = String.fromCharCode(view.getUint8(entryBase + 8));
            if (tag === 0x0001) latRef = ref;
            else lonRef = ref;
        }
        // 0x0002 = GPSLatitude, 0x0004 = GPSLongitude (RATIONAL x3)
        if ((tag === 0x0002 || tag === 0x0004) && type === 5 && count === 3) {
            const dataOffset = tiffStart + valField;
            const dms = readRationalTriple(view, dataOffset, le);
            if (tag === 0x0002) latDMS = dms;
            else lonDMS = dms;
        }
    }

    if (latDMS) result.lat = dmsToDecimal(latDMS, latRef);
    if (lonDMS) result.lon = dmsToDecimal(lonDMS, lonRef);
}

function readRationalTriple(view, offset, le) {
    const result = [];
    for (let i = 0; i < 3; i++) {
        const num = view.getUint32(offset + i * 8, le);
        const den = view.getUint32(offset + i * 8 + 4, le);
        result.push(den !== 0 ? num / den : 0);
    }
    return result; // [degrees, minutes, seconds]
}

function dmsToDecimal([d, m, s], ref) {
    let decimal = d + m / 60 + s / 3600;
    if (ref === 'S' || ref === 'W') decimal = -decimal;
    return parseFloat(decimal.toFixed(7));
}

function getString(view, offset, length) {
    let str = '';
    for (let i = 0; i < length && offset + i < view.byteLength; i++) {
        str += String.fromCharCode(view.getUint8(offset + i));
    }
    return str;
}

/* ════════════════════════════════════════════
   Digital Signature Builder
   ════════════════════════════════════════════ */

function buildSignature(exifData) {
    // Format EXIF timestamp "2024:05:01 14:32:00" → ISO 8601
    let ts = null;
    if (exifData.timestamp) {
        // Replace first two colons in date part with dashes
        ts = exifData.timestamp.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3');
    }
    return {
        lat: exifData.lat,
        lon: exifData.lon,
        timestamp: ts ?? new Date().toISOString(), // fallback to submission time
    };
}

/* ── Helpers ── */
function postProgress(pct) {
    self.postMessage({ type: 'progress', pct });
}
