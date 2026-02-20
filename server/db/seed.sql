-- ═══════════════════════════════════════════════════════════
-- CivicPulse — Seed Data: 10 Central Delhi Wards
-- Realistic polygons covering major landmarks
-- ═══════════════════════════════════════════════════════════

-- Ward 1: Connaught Place / Rajiv Chowk Area
INSERT INTO city_wards (ward_name, zone, officer_name, officer_email, officer_phone, ward_geometry)
VALUES (
    'Connaught Place', 'New Delhi', 'Priya Sharma', 'priya.sharma@mcd.gov.in', '+91-98100-10001',
    ST_GeomFromText('MULTIPOLYGON(((
        77.2100 28.6280, 77.2100 28.6380, 77.2250 28.6380, 77.2250 28.6280, 77.2100 28.6280
    )))', 4326)
);

-- Ward 2: India Gate / Rajpath Area
INSERT INTO city_wards (ward_name, zone, officer_name, officer_email, officer_phone, ward_geometry)
VALUES (
    'India Gate', 'New Delhi', 'Rahul Verma', 'rahul.verma@mcd.gov.in', '+91-98100-10002',
    ST_GeomFromText('MULTIPOLYGON(((
        77.2250 28.6080, 77.2250 28.6280, 77.2450 28.6280, 77.2450 28.6080, 77.2250 28.6080
    )))', 4326)
);

-- Ward 3: Karol Bagh
INSERT INTO city_wards (ward_name, zone, officer_name, officer_email, officer_phone, ward_geometry)
VALUES (
    'Karol Bagh', 'Central', 'Anita Gupta', 'anita.gupta@mcd.gov.in', '+91-98100-10003',
    ST_GeomFromText('MULTIPOLYGON(((
        77.1850 28.6400, 77.1850 28.6550, 77.2100 28.6550, 77.2100 28.6400, 77.1850 28.6400
    )))', 4326)
);

-- Ward 4: Chandni Chowk / Old Delhi
INSERT INTO city_wards (ward_name, zone, officer_name, officer_email, officer_phone, ward_geometry)
VALUES (
    'Chandni Chowk', 'North', 'Vikram Singh', 'vikram.singh@mcd.gov.in', '+91-98100-10004',
    ST_GeomFromText('MULTIPOLYGON(((
        77.2200 28.6450, 77.2200 28.6600, 77.2450 28.6600, 77.2450 28.6450, 77.2200 28.6450
    )))', 4326)
);

-- Ward 5: Lajpat Nagar / Defence Colony
INSERT INTO city_wards (ward_name, zone, officer_name, officer_email, officer_phone, ward_geometry)
VALUES (
    'Lajpat Nagar', 'South', 'Deepa Krishnan', 'deepa.krishnan@mcd.gov.in', '+91-98100-10005',
    ST_GeomFromText('MULTIPOLYGON(((
        77.2300 28.5650, 77.2300 28.5850, 77.2550 28.5850, 77.2550 28.5650, 77.2300 28.5650
    )))', 4326)
);

-- Ward 6: Hauz Khas
INSERT INTO city_wards (ward_name, zone, officer_name, officer_email, officer_phone, ward_geometry)
VALUES (
    'Hauz Khas', 'South', 'Arjun Malhotra', 'arjun.malhotra@mcd.gov.in', '+91-98100-10006',
    ST_GeomFromText('MULTIPOLYGON(((
        77.1900 28.5450, 77.1900 28.5650, 77.2200 28.5650, 77.2200 28.5450, 77.1900 28.5450
    )))', 4326)
);

-- Ward 7: Sarojini Nagar / Dilli Haat
INSERT INTO city_wards (ward_name, zone, officer_name, officer_email, officer_phone, ward_geometry)
VALUES (
    'Sarojini Nagar', 'South West', 'Meena Iyer', 'meena.iyer@mcd.gov.in', '+91-98100-10007',
    ST_GeomFromText('MULTIPOLYGON(((
        77.1950 28.5700, 77.1950 28.5900, 77.2150 28.5900, 77.2150 28.5700, 77.1950 28.5700
    )))', 4326)
);

-- Ward 8: Paharganj
INSERT INTO city_wards (ward_name, zone, officer_name, officer_email, officer_phone, ward_geometry)
VALUES (
    'Paharganj', 'Central', 'Sanjay Tiwari', 'sanjay.tiwari@mcd.gov.in', '+91-98100-10008',
    ST_GeomFromText('MULTIPOLYGON(((
        77.2050 28.6380, 77.2050 28.6500, 77.2200 28.6500, 77.2200 28.6380, 77.2050 28.6380
    )))', 4326)
);

-- Ward 9: Lodhi Colony / Jor Bagh
INSERT INTO city_wards (ward_name, zone, officer_name, officer_email, officer_phone, ward_geometry)
VALUES (
    'Lodhi Colony', 'New Delhi', 'Kavita Reddy', 'kavita.reddy@mcd.gov.in', '+91-98100-10009',
    ST_GeomFromText('MULTIPOLYGON(((
        77.2150 28.5850, 77.2150 28.6080, 77.2400 28.6080, 77.2400 28.5850, 77.2150 28.5850
    )))', 4326)
);

-- Ward 10: ITO / Pragati Maidan
INSERT INTO city_wards (ward_name, zone, officer_name, officer_email, officer_phone, ward_geometry)
VALUES (
    'ITO', 'East', 'Rajesh Kumar', 'rajesh.kumar@mcd.gov.in', '+91-98100-10010',
    ST_GeomFromText('MULTIPOLYGON(((
        77.2450 28.6200, 77.2450 28.6450, 77.2700 28.6450, 77.2700 28.6200, 77.2450 28.6200
    )))', 4326)
);

-- Verify seeded data
SELECT ward_id, ward_name, zone, officer_name,
       ST_AsText(ST_Centroid(ward_geometry)) AS centroid
FROM city_wards
ORDER BY ward_id;
