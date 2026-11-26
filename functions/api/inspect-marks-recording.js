
import { connectDB, json } from "../_utils.js";
import { jwtVerify } from "jose";

/* =====================================================
   FILA GRADES SYSTEM
   SECTOR ADMIN — INSPECT MARKS RECORDING API

   ACTIONS:
   - get_open_tests
   - get_examination_periods
   - get_school_progress
   - get_teacher_progress
   - get_teacher_breakdown

   RECORD TYPES:
   - tests
   - examinations
===================================================== */


/* =====================================================
   AUTHENTICATION
===================================================== */

function getCookie(request, name) {
    const cookieHeader = request.headers.get("Cookie") || "";

    for (const cookie of cookieHeader.split(";")) {
        const separator = cookie.indexOf("=");

        if (separator === -1) continue;

        const key = cookie.slice(0, separator).trim();

        if (key === name) {
            return decodeURIComponent(
                cookie.slice(separator + 1).trim()
            );
        }
    }

    return null;
}

async function authenticateSectorAdmin(context, client) {
    const token = getCookie(context.request, "ses_token");

    if (!token) {
        throw new Error("UNAUTHORIZED");
    }

    const secret = context.env.JWT_SECRET;

    if (!secret) {
        throw new Error("SERVER_CONFIGURATION_ERROR");
    }

    let payload;

    try {
        const secretKey = new TextEncoder().encode(secret);

        const verified = await jwtVerify(token, secretKey, {
            algorithms: ["HS256"]
        });

        payload = verified.payload;
    } catch {
        throw new Error("UNAUTHORIZED");
    }

    if (
        payload.role !== "sector_admin" ||
        !payload.sub ||
        !payload.sector_id
    ) {
        throw new Error("FORBIDDEN");
    }

    const result = await client.query(
        `
        SELECT
            id,
            role,
            sector_id,
            status
        FROM users
        WHERE id = $1
        LIMIT 1
        `,
        [payload.sub]
    );

    const admin = result.rows[0];

    if (
        !admin ||
        admin.role !== "sector_admin" ||
        admin.status !== "active" ||
        String(admin.sector_id) !== String(payload.sector_id)
    ) {
        throw new Error("FORBIDDEN");
    }

    return admin;
}


/* =====================================================
   VALIDATION
===================================================== */

function validId(value) {
    return /^\d+$/.test(String(value || ""));
}

function validateRecordType(value) {
    if (!["tests", "examinations"].includes(value)) {
        throw new Error("INVALID_RECORD_TYPE");
    }

    return value;
}

function optionalTermNumber(value) {
    if (value === null || value === undefined || value === "") {
        return null;
    }

    if (!/^\d+$/.test(String(value))) {
        throw new Error("INVALID_TERM");
    }

    const number = Number(value);

    if (!Number.isSafeInteger(number) || number < 1) {
        throw new Error("INVALID_TERM");
    }

    return number;
}

function calculateSummary(rows, totalField = null) {
    const summary = {
        expected_marks: 0,
        recorded_marks: 0,
        missing_marks: 0
    };

    for (const row of rows) {
        summary.expected_marks += Number(row.expected_marks || 0);
        summary.recorded_marks += Number(row.recorded_marks || 0);
        summary.missing_marks += Number(row.missing_marks || 0);
    }

    if (totalField) {
        summary[totalField] = rows.length;
    }

    return summary;
}


/* =====================================================
   OPEN TESTS

   Only open tests belonging to this sector are returned.

   Latest test is first:
   created_at DESC, id DESC.

   Each test includes the school-specific academic
   year and term attached through test_schools.
===================================================== */

async function getOpenTests(client, sectorId) {
    const result = await client.query(
        `
        SELECT
            t.id AS test_id,
            t.test_name,
            t.status,
            t.created_at,
            t.closing_at,

            COALESCE(
                JSON_AGG(
                    DISTINCT JSONB_BUILD_OBJECT(
                        'school_id', s.id,
                        'school_name', s.school_name,
                        'academic_year_id', tsc.academic_year_id,
                        'academic_year', ay.year_name,
                        'term_id', tsc.term_id,
                        'term', tr.term_name,
                        'term_number', tr.term_number
                    )
                ) FILTER (
                    WHERE s.id IS NOT NULL
                ),
                '[]'::json
            ) AS periods

        FROM tests t

        LEFT JOIN test_schools tsc
            ON tsc.test_id = t.id

        LEFT JOIN schools s
            ON s.id = tsc.school_id
            AND s.sector_id = $1

        LEFT JOIN academic_years ay
            ON ay.id = tsc.academic_year_id
            AND ay.school_id = tsc.school_id

        LEFT JOIN terms tr
            ON tr.id = tsc.term_id
            AND tr.school_id = tsc.school_id
            AND tr.academic_year_id = tsc.academic_year_id

        WHERE t.sector_id = $1
          AND LOWER(t.status) = 'open'

        GROUP BY
            t.id,
            t.test_name,
            t.status,
            t.created_at,
            t.closing_at

        ORDER BY
            t.created_at DESC NULLS LAST,
            t.id DESC
        `,
        [sectorId]
    );

    return result.rows;
}


/* =====================================================
   EXAMINATION ACADEMIC PERIODS

   Periods are grouped by year name and term number,
   not by database IDs, because academic period IDs
   are school-specific.
===================================================== */

async function getExaminationPeriods(client, sectorId) {
    const result = await client.query(
        `
        SELECT DISTINCT
            ay.year_name AS academic_year,
            tr.term_number,
            tr.term_name AS term

        FROM examinations e

        INNER JOIN schools s
            ON s.id = e.school_id
            AND s.sector_id = $1

        LEFT JOIN academic_years ay
            ON ay.id = e.academic_year_id
            AND ay.school_id = e.school_id

        LEFT JOIN terms tr
            ON tr.id = e.term_id
            AND tr.school_id = e.school_id
            AND tr.academic_year_id = e.academic_year_id

        WHERE e.academic_year_id IS NOT NULL
           OR e.term_id IS NOT NULL

        ORDER BY
            ay.year_name DESC NULLS LAST,
            tr.term_number ASC NULLS LAST
        `,
        [sectorId]
    );

    return result.rows;
}


/* =====================================================
   SCHOOL PROGRESS — TESTS

   IMPORTANT:
   Expected entries are counted only when an active
   student enrollment matches:

   - test
   - school
   - class
   - academic year
   - term

   The selected test is the only test counted.
===================================================== */

async function getTestSchoolProgress(
    client,
    sectorId,
    testId
) {
    const result = await client.query(
        `
        WITH expected AS (
            SELECT DISTINCT
                tc.school_id,
                t.id AS test_id,
                tc.class_id,
                ts.subject_id,
                st.id AS student_id

            FROM tests t

            INNER JOIN test_schools tsc
                ON tsc.test_id = t.id

            INNER JOIN test_classes tc
                ON tc.test_id = t.id
                AND tc.school_id = tsc.school_id

            INNER JOIN test_subjects ts
                ON ts.test_id = t.id

            INNER JOIN schools s
                ON s.id = tc.school_id
                AND s.sector_id = $1

            INNER JOIN students st
                ON st.school_id = tc.school_id
                AND st.class_id = tc.class_id
                AND st.status = 'active'

            INNER JOIN student_enrollments se
                ON se.student_id = st.id
                AND se.school_id = tc.school_id
                AND se.class_id = tc.class_id
                AND se.academic_year_id = tsc.academic_year_id
                AND se.term_id = tsc.term_id
                AND LOWER(se.status) = 'active'

            WHERE t.id = $2
              AND t.sector_id = $1
              AND LOWER(t.status) = 'open'
        ),

        progress AS (
            SELECT
                e.school_id,
                COUNT(*)::int AS expected_marks,
                COUNT(m.id)::int AS recorded_marks

            FROM expected e

            LEFT JOIN marks m
                ON m.test_id = e.test_id
                AND m.student_id = e.student_id
                AND m.class_id = e.class_id
                AND m.subject_id = e.subject_id

            GROUP BY e.school_id
        ),

        school_period AS (
            SELECT
                tsc.school_id,
                MAX(ay.year_name) AS academic_year,
                MAX(tr.term_name) AS term,
                MAX(tr.term_number) AS term_number

            FROM test_schools tsc

            INNER JOIN academic_years ay
                ON ay.id = tsc.academic_year_id
                AND ay.school_id = tsc.school_id

            INNER JOIN terms tr
                ON tr.id = tsc.term_id
                AND tr.school_id = tsc.school_id
                AND tr.academic_year_id = tsc.academic_year_id

            WHERE tsc.test_id = $2

            GROUP BY tsc.school_id
        ),

        teacher_counts AS (
            SELECT
                t.school_id,
                COUNT(DISTINCT t.id)::int AS teacher_count

            FROM teachers t

            INNER JOIN users u
                ON u.id = t.user_id

            WHERE u.role = 'teacher'
              AND t.school_id IN (
                  SELECT id
                  FROM schools
                  WHERE sector_id = $1
              )

            GROUP BY t.school_id
        )

        SELECT
            s.id AS school_id,
            s.school_name,
            s.school_code,

            sp.academic_year,
            sp.term,
            sp.term_number,

            COALESCE(tc.teacher_count, 0)::int
                AS teacher_count,

            COALESCE(p.expected_marks, 0)::int
                AS expected_marks,

            COALESCE(p.recorded_marks, 0)::int
                AS recorded_marks,

            GREATEST(
                COALESCE(p.expected_marks, 0) -
                COALESCE(p.recorded_marks, 0),
                0
            )::int AS missing_marks,

            CASE
                WHEN COALESCE(p.expected_marks, 0) = 0
                    THEN 0
                ELSE ROUND(
                    (
                        COALESCE(p.recorded_marks, 0)::numeric /
                        p.expected_marks
                    ) * 100,
                    1
                )
            END AS completion_percentage

        FROM schools s

        LEFT JOIN progress p
            ON p.school_id = s.id

        LEFT JOIN teacher_counts tc
            ON tc.school_id = s.id

        LEFT JOIN school_period sp
            ON sp.school_id = s.id

        WHERE s.sector_id = $1

        ORDER BY
            completion_percentage DESC,
            s.school_name ASC
        `,
        [sectorId, testId]
    );

    return result.rows;
}


/* =====================================================
   SCHOOL PROGRESS — EXAMINATIONS

   Independent of the Tests selector.

   Academic-year and term filters use their names and
   term numbers, allowing school-specific IDs.
===================================================== */

async function getExaminationSchoolProgress(
    client,
    sectorId,
    academicYear,
    termNumber
) {
    const result = await client.query(
        `
        WITH expected AS (
            SELECT
                e.school_id,
                e.id AS examination_id,
                e.class_id,
                e.subject_id,
                st.id AS student_id

            FROM examinations e

            INNER JOIN schools s
                ON s.id = e.school_id
                AND s.sector_id = $1

            INNER JOIN students st
                ON st.school_id = e.school_id
                AND st.class_id = e.class_id
                AND st.status = 'active'

            LEFT JOIN academic_years ay
                ON ay.id = e.academic_year_id
                AND ay.school_id = e.school_id

            LEFT JOIN terms tr
                ON tr.id = e.term_id
                AND tr.school_id = e.school_id
                AND tr.academic_year_id = e.academic_year_id

            WHERE ($2::text IS NULL OR ay.year_name = $2)
              AND ($3::int IS NULL OR tr.term_number = $3)
        ),

        progress AS (
            SELECT
                e.school_id,
                COUNT(*)::int AS expected_marks,
                COUNT(m.id)::int AS recorded_marks

            FROM expected e

            LEFT JOIN marks m
                ON m.examination_id = e.examination_id
                AND m.student_id = e.student_id
                AND m.class_id = e.class_id

            GROUP BY e.school_id
        ),

        teacher_counts AS (
            SELECT
                t.school_id,
                COUNT(DISTINCT t.id)::int AS teacher_count

            FROM teachers t

            INNER JOIN users u
                ON u.id = t.user_id

            WHERE u.role = 'teacher'
              AND t.school_id IN (
                  SELECT id
                  FROM schools
                  WHERE sector_id = $1
              )

            GROUP BY t.school_id
        )

        SELECT
            s.id AS school_id,
            s.school_name,
            s.school_code,

            COALESCE(tc.teacher_count, 0)::int
                AS teacher_count,

            COALESCE(p.expected_marks, 0)::int
                AS expected_marks,

            COALESCE(p.recorded_marks, 0)::int
                AS recorded_marks,

            GREATEST(
                COALESCE(p.expected_marks, 0) -
                COALESCE(p.recorded_marks, 0),
                0
            )::int AS missing_marks,

            CASE
                WHEN COALESCE(p.expected_marks, 0) = 0
                    THEN 0
                ELSE ROUND(
                    (
                        COALESCE(p.recorded_marks, 0)::numeric /
                        p.expected_marks
                    ) * 100,
                    1
                )
            END AS completion_percentage

        FROM schools s

        LEFT JOIN progress p
            ON p.school_id = s.id

        LEFT JOIN teacher_counts tc
            ON tc.school_id = s.id

        WHERE s.sector_id = $1

        ORDER BY
            completion_percentage DESC,
            s.school_name ASC
        `,
        [sectorId, academicYear, termNumber]
    );

    return result.rows;
}


/* =====================================================
   TEACHER PROGRESS — TESTS
===================================================== */

async function getTestTeacherProgress(
    client,
    sectorId,
    schoolId,
    testId
) {
    const result = await client.query(
        `
        WITH assignments AS (
            SELECT
                ta.teacher_id,
                ta.school_id,
                ta.class_id,
                ta.subject_id,
                t.user_id,
                u.full_name,
                u.phone

            FROM teacher_assignments ta

            INNER JOIN teachers t
                ON t.id = ta.teacher_id
                AND t.school_id = ta.school_id

            INNER JOIN users u
                ON u.id = t.user_id

            INNER JOIN schools s
                ON s.id = ta.school_id

            WHERE ta.school_id = $2
              AND s.sector_id = $1
              AND u.role = 'teacher'
        ),

        expected AS (
            SELECT DISTINCT
                a.teacher_id,
                a.user_id,
                a.class_id,
                a.subject_id,
                tc.school_id,
                tests.id AS test_id,
                st.id AS student_id

            FROM assignments a

            INNER JOIN test_classes tc
                ON tc.school_id = a.school_id
                AND tc.class_id = a.class_id
                AND tc.test_id = $3

            INNER JOIN test_schools tsc
                ON tsc.test_id = tc.test_id
                AND tsc.school_id = tc.school_id

            INNER JOIN tests
                ON tests.id = tc.test_id
                AND tests.sector_id = $1
                AND LOWER(tests.status) = 'open'

            INNER JOIN test_subjects ts
                ON ts.test_id = tests.id
                AND ts.subject_id = a.subject_id

            INNER JOIN students st
                ON st.school_id = a.school_id
                AND st.class_id = a.class_id
                AND st.status = 'active'

            INNER JOIN student_enrollments se
                ON se.student_id = st.id
                AND se.school_id = a.school_id
                AND se.class_id = a.class_id
                AND se.academic_year_id = tsc.academic_year_id
                AND se.term_id = tsc.term_id
                AND LOWER(se.status) = 'active'

            WHERE tests.id = $3
        ),

        progress AS (
            SELECT
                e.teacher_id,
                COUNT(*)::int AS expected_marks,
                COUNT(m.id)::int AS recorded_marks

            FROM expected e

            LEFT JOIN marks m
                ON m.test_id = e.test_id
                AND m.student_id = e.student_id
                AND m.class_id = e.class_id
                AND m.subject_id = e.subject_id
                AND m.recorded_by = e.user_id

            GROUP BY e.teacher_id
        ),

        assignment_counts AS (
            SELECT
                teacher_id,
                COUNT(DISTINCT class_id)::int
                    AS assigned_classes_count,
                COUNT(DISTINCT subject_id)::int
                    AS assigned_subjects_count

            FROM assignments
            GROUP BY teacher_id
        )

        SELECT
            a.teacher_id,
            a.full_name,
            a.phone,

            COALESCE(ac.assigned_classes_count, 0)::int
                AS assigned_classes_count,

            COALESCE(ac.assigned_subjects_count, 0)::int
                AS assigned_subjects_count,

            COALESCE(p.expected_marks, 0)::int
                AS expected_marks,

            COALESCE(p.recorded_marks, 0)::int
                AS recorded_marks,

            GREATEST(
                COALESCE(p.expected_marks, 0) -
                COALESCE(p.recorded_marks, 0),
                0
            )::int AS missing_marks,

            CASE
                WHEN COALESCE(p.expected_marks, 0) = 0
                    THEN 0
                ELSE ROUND(
                    (
                        COALESCE(p.recorded_marks, 0)::numeric /
                        p.expected_marks
                    ) * 100,
                    1
                )
            END AS completion_percentage

        FROM (
            SELECT DISTINCT
                teacher_id,
                full_name,
                phone
            FROM assignments
        ) a

        LEFT JOIN progress p
            ON p.teacher_id = a.teacher_id

        LEFT JOIN assignment_counts ac
            ON ac.teacher_id = a.teacher_id

        ORDER BY
            completion_percentage DESC,
            a.full_name ASC
        `,
        [sectorId, schoolId, testId]
    );

    return result.rows;
}


/* =====================================================
   TEACHER PROGRESS — EXAMINATIONS
===================================================== */

async function getExaminationTeacherProgress(
    client,
    sectorId,
    schoolId,
    academicYear,
    termNumber
) {
    const result = await client.query(
        `
        WITH assignments AS (
            SELECT
                ta.teacher_id,
                ta.school_id,
                ta.class_id,
                ta.subject_id,
                t.user_id,
                u.full_name,
                u.phone

            FROM teacher_assignments ta

            INNER JOIN teachers t
                ON t.id = ta.teacher_id
                AND t.school_id = ta.school_id

            INNER JOIN users u
                ON u.id = t.user_id

            INNER JOIN schools s
                ON s.id = ta.school_id

            WHERE ta.school_id = $2
              AND s.sector_id = $1
              AND u.role = 'teacher'
        ),

        expected AS (
            SELECT DISTINCT
                a.teacher_id,
                a.user_id,
                a.class_id,
                a.subject_id,
                e.id AS examination_id,
                st.id AS student_id

            FROM assignments a

            INNER JOIN examinations e
                ON e.school_id = a.school_id
                AND e.class_id = a.class_id
                AND e.subject_id = a.subject_id

            INNER JOIN students st
                ON st.school_id = a.school_id
                AND st.class_id = a.class_id
                AND st.status = 'active'

            LEFT JOIN academic_years ay
                ON ay.id = e.academic_year_id
                AND ay.school_id = e.school_id

            LEFT JOIN terms tr
                ON tr.id = e.term_id
                AND tr.school_id = e.school_id
                AND tr.academic_year_id = e.academic_year_id

            WHERE ($3::text IS NULL OR ay.year_name = $3)
              AND ($4::int IS NULL OR tr.term_number = $4)
        ),

        progress AS (
            SELECT
                e.teacher_id,
                COUNT(*)::int AS expected_marks,
                COUNT(m.id)::int AS recorded_marks

            FROM expected e

            LEFT JOIN marks m
                ON m.examination_id = e.examination_id
                AND m.student_id = e.student_id
                AND m.class_id = e.class_id
                AND m.recorded_by = e.user_id

            GROUP BY e.teacher_id
        ),

        assignment_counts AS (
            SELECT
                teacher_id,
                COUNT(DISTINCT class_id)::int
                    AS assigned_classes_count,
                COUNT(DISTINCT subject_id)::int
                    AS assigned_subjects_count

            FROM assignments
            GROUP BY teacher_id
        )

        SELECT
            a.teacher_id,
            a.full_name,
            a.phone,

            COALESCE(ac.assigned_classes_count, 0)::int
                AS assigned_classes_count,

            COALESCE(ac.assigned_subjects_count, 0)::int
                AS assigned_subjects_count,

            COALESCE(p.expected_marks, 0)::int
                AS expected_marks,

            COALESCE(p.recorded_marks, 0)::int
                AS recorded_marks,

            GREATEST(
                COALESCE(p.expected_marks, 0) -
                COALESCE(p.recorded_marks, 0),
                0
            )::int AS missing_marks,

            CASE
                WHEN COALESCE(p.expected_marks, 0) = 0
                    THEN 0
                ELSE ROUND(
                    (
                        COALESCE(p.recorded_marks, 0)::numeric /
                        p.expected_marks
                    ) * 100,
                    1
                )
            END AS completion_percentage

        FROM (
            SELECT DISTINCT
                teacher_id,
                full_name,
                phone
            FROM assignments
        ) a

        LEFT JOIN progress p
            ON p.teacher_id = a.teacher_id

        LEFT JOIN assignment_counts ac
            ON ac.teacher_id = a.teacher_id

        ORDER BY
            completion_percentage DESC,
            a.full_name ASC
        `,
        [sectorId, schoolId, academicYear, termNumber]
    );

    return result.rows;
}


/* =====================================================
   TEACHER BREAKDOWN — TESTS
===================================================== */

async function getTestTeacherBreakdown(
    client,
    sectorId,
    schoolId,
    teacherId,
    testId
) {
    const result = await client.query(
        `
        WITH assignment_scope AS (
            SELECT
                ta.teacher_id,
                ta.school_id,
                ta.class_id,
                ta.subject_id,
                t.user_id

            FROM teacher_assignments ta

            INNER JOIN teachers t
                ON t.id = ta.teacher_id
                AND t.school_id = ta.school_id

            INNER JOIN schools s
                ON s.id = ta.school_id

            INNER JOIN users u
                ON u.id = t.user_id

            WHERE ta.teacher_id = $3
              AND ta.school_id = $2
              AND s.sector_id = $1
              AND u.role = 'teacher'
        ),

        expected AS (
            SELECT DISTINCT
                a.class_id,
                a.subject_id,
                a.user_id,
                tests.id AS test_id,
                st.id AS student_id

            FROM assignment_scope a

            INNER JOIN test_classes tc
                ON tc.school_id = a.school_id
                AND tc.class_id = a.class_id
                AND tc.test_id = $4

            INNER JOIN test_schools tsc
                ON tsc.test_id = tc.test_id
                AND tsc.school_id = tc.school_id

            INNER JOIN tests
                ON tests.id = tc.test_id
                AND tests.sector_id = $1
                AND LOWER(tests.status) = 'open'

            INNER JOIN test_subjects ts
                ON ts.test_id = tests.id
                AND ts.subject_id = a.subject_id

            INNER JOIN students st
                ON st.school_id = a.school_id
                AND st.class_id = a.class_id
                AND st.status = 'active'

            INNER JOIN student_enrollments se
                ON se.student_id = st.id
                AND se.school_id = a.school_id
                AND se.class_id = a.class_id
                AND se.academic_year_id = tsc.academic_year_id
                AND se.term_id = tsc.term_id
                AND LOWER(se.status) = 'active'

            WHERE tests.id = $4
        ),

        progress AS (
            SELECT
                e.class_id,
                e.subject_id,
                COUNT(*)::int AS expected_marks,
                COUNT(m.id)::int AS recorded_marks

            FROM expected e

            LEFT JOIN marks m
                ON m.test_id = e.test_id
                AND m.student_id = e.student_id
                AND m.class_id = e.class_id
                AND m.subject_id = e.subject_id
                AND m.recorded_by = e.user_id

            GROUP BY
                e.class_id,
                e.subject_id
        )

        SELECT
            c.id AS class_id,
            c.class_name,
            sub.id AS subject_id,
            sub.subject_name,

            p.expected_marks,
            p.recorded_marks,

            GREATEST(
                p.expected_marks - p.recorded_marks,
                0
            )::int AS missing_marks,

            CASE
                WHEN p.expected_marks = 0 THEN 0
                ELSE ROUND(
                    (
                        p.recorded_marks::numeric /
                        p.expected_marks
                    ) * 100,
                    1
                )
            END AS completion_percentage

        FROM progress p

        INNER JOIN classes c
            ON c.id = p.class_id

        INNER JOIN subjects sub
            ON sub.id = p.subject_id

        ORDER BY
            c.class_name ASC,
            sub.subject_name ASC
        `,
        [sectorId, schoolId, teacherId, testId]
    );

    return result.rows;
}


/* =====================================================
   TEACHER BREAKDOWN — EXAMINATIONS
===================================================== */

async function getExaminationTeacherBreakdown(
    client,
    sectorId,
    schoolId,
    teacherId,
    academicYear,
    termNumber
) {
    const result = await client.query(
        `
        WITH assignment_scope AS (
            SELECT
                ta.teacher_id,
                ta.school_id,
                ta.class_id,
                ta.subject_id,
                t.user_id

            FROM teacher_assignments ta

            INNER JOIN teachers t
                ON t.id = ta.teacher_id
                AND t.school_id = ta.school_id

            INNER JOIN schools s
                ON s.id = ta.school_id

            INNER JOIN users u
                ON u.id = t.user_id

            WHERE ta.teacher_id = $3
              AND ta.school_id = $2
              AND s.sector_id = $1
              AND u.role = 'teacher'
        ),

        expected AS (
            SELECT DISTINCT
                a.class_id,
                a.subject_id,
                a.user_id,
                e.id AS examination_id,
                st.id AS student_id

            FROM assignment_scope a

            INNER JOIN examinations e
                ON e.school_id = a.school_id
                AND e.class_id = a.class_id
                AND e.subject_id = a.subject_id

            INNER JOIN students st
                ON st.school_id = a.school_id
                AND st.class_id = a.class_id
                AND st.status = 'active'

            LEFT JOIN academic_years ay
                ON ay.id = e.academic_year_id
                AND ay.school_id = e.school_id

            LEFT JOIN terms tr
                ON tr.id = e.term_id
                AND tr.school_id = e.school_id
                AND tr.academic_year_id = e.academic_year_id

            WHERE ($4::text IS NULL OR ay.year_name = $4)
              AND ($5::int IS NULL OR tr.term_number = $5)
        ),

        progress AS (
            SELECT
                e.class_id,
                e.subject_id,
                COUNT(*)::int AS expected_marks,
                COUNT(m.id)::int AS recorded_marks

            FROM expected e

            LEFT JOIN marks m
                ON m.examination_id = e.examination_id
                AND m.student_id = e.student_id
                AND m.class_id = e.class_id
                AND m.recorded_by = e.user_id

            GROUP BY
                e.class_id,
                e.subject_id
        )

        SELECT
            c.id AS class_id,
            c.class_name,
            sub.id AS subject_id,
            sub.subject_name,

            p.expected_marks,
            p.recorded_marks,

            GREATEST(
                p.expected_marks - p.recorded_marks,
                0
            )::int AS missing_marks,

            CASE
                WHEN p.expected_marks = 0 THEN 0
                ELSE ROUND(
                    (
                        p.recorded_marks::numeric /
                        p.expected_marks
                    ) * 100,
                    1
                )
            END AS completion_percentage

        FROM progress p

        INNER JOIN classes c
            ON c.id = p.class_id

        INNER JOIN subjects sub
            ON sub.id = p.subject_id

        ORDER BY
            c.class_name ASC,
            sub.subject_name ASC
        `,
        [sectorId, schoolId, teacherId, academicYear, termNumber]
    );

    return result.rows;
}


/* =====================================================
   MAIN HANDLER
===================================================== */

export async function onRequest(context) {
    if (context.request.method !== "GET") {
        return json({
            success: false,
            message: "Method not allowed."
        }, 405);
    }

    let client;

    try {
        const url = new URL(context.request.url);

        const action = url.searchParams.get("action");

        const recordType = validateRecordType(
            url.searchParams.get("record_type") || "tests"
        );

        client = await connectDB(context);

        const admin = await authenticateSectorAdmin(
            context,
            client
        );

        const sectorId = admin.sector_id;

        /* ---------------------------------------------
           ACTION 1: OPEN TESTS
        --------------------------------------------- */

        if (action === "get_open_tests") {
            const tests = await getOpenTests(client, sectorId);

            return json({
                success: true,
                tests
            });
        }

        /* ---------------------------------------------
           ACTION 2: EXAMINATION PERIODS
        --------------------------------------------- */

        if (action === "get_examination_periods") {
            const periods = await getExaminationPeriods(
                client,
                sectorId
            );

            return json({
                success: true,
                periods
            });
        }

        /* ---------------------------------------------
           EXAMINATION FILTERS
        --------------------------------------------- */

        const academicYear =
            url.searchParams.get("academic_year") || null;

        const termNumber = recordType === "examinations"
            ? optionalTermNumber(
                url.searchParams.get("term_number")
            )
            : null;

        /* ---------------------------------------------
           TEST SELECTION
        --------------------------------------------- */

        let testId = null;

        if (recordType === "tests") {
            testId = url.searchParams.get("test_id");

            if (!validId(testId)) {
                return json({
                    success: false,
                    message: "Please select an open test."
                }, 400);
            }

            const testCheck = await client.query(
                `
                SELECT id, test_name
                FROM tests
                WHERE id = $1
                  AND sector_id = $2
                  AND LOWER(status) = 'open'
                LIMIT 1
                `,
                [testId, sectorId]
            );

            if (!testCheck.rows.length) {
                return json({
                    success: false,
                    message: "The selected test is no longer open. Please select another open test."
                }, 404);
            }
        }

        /* ---------------------------------------------
           ACTION 3: SCHOOL PROGRESS
        --------------------------------------------- */

        if (action === "get_school_progress") {
            const rows = recordType === "tests"
                ? await getTestSchoolProgress(
                    client,
                    sectorId,
                    testId
                )
                : await getExaminationSchoolProgress(
                    client,
                    sectorId,
                    academicYear,
                    termNumber
                );

            const summary = calculateSummary(
                rows,
                "total_schools"
            );

            return json({
                success: true,
                record_type: recordType,
                test_id: testId,
                academic_year: academicYear,
                term_number: termNumber,
                schools: rows,
                summary
            });
        }

        /* ---------------------------------------------
           ACTION 4: TEACHER PROGRESS
        --------------------------------------------- */

        if (action === "get_teacher_progress") {
            const schoolId = url.searchParams.get("school_id");

            if (!validId(schoolId)) {
                return json({
                    success: false,
                    message: "A valid school ID is required."
                }, 400);
            }

            const schoolCheck = await client.query(
                `
                SELECT id, school_name, school_code
                FROM schools
                WHERE id = $1
                  AND sector_id = $2
                LIMIT 1
                `,
                [schoolId, sectorId]
            );

            if (!schoolCheck.rows.length) {
                return json({
                    success: false,
                    message: "School not found in your sector."
                }, 404);
            }

            const rows = recordType === "tests"
                ? await getTestTeacherProgress(
                    client,
                    sectorId,
                    schoolId,
                    testId
                )
                : await getExaminationTeacherProgress(
                    client,
                    sectorId,
                    schoolId,
                    academicYear,
                    termNumber
                );

            const summary = calculateSummary(rows);
            summary.total_teachers = rows.length;

            return json({
                success: true,
                record_type: recordType,
                test_id: testId,
                academic_year: academicYear,
                term_number: termNumber,
                school: schoolCheck.rows[0],
                teachers: rows,
                summary
            });
        }

        /* ---------------------------------------------
           ACTION 5: TEACHER CLASS/SUBJECT BREAKDOWN
        --------------------------------------------- */

        if (action === "get_teacher_breakdown") {
            const schoolId = url.searchParams.get("school_id");
            const teacherId = url.searchParams.get("teacher_id");

            if (!validId(schoolId) || !validId(teacherId)) {
                return json({
                    success: false,
                    message: "Valid school and teacher IDs are required."
                }, 400);
            }

            const teacherCheck = await client.query(
                `
                SELECT
                    t.id AS teacher_id,
                    u.full_name,
                    t.school_id

                FROM teachers t

                INNER JOIN users u
                    ON u.id = t.user_id

                INNER JOIN schools s
                    ON s.id = t.school_id

                WHERE t.id = $1
                  AND t.school_id = $2
                  AND s.sector_id = $3
                  AND u.role = 'teacher'

                LIMIT 1
                `,
                [teacherId, schoolId, sectorId]
            );

            if (!teacherCheck.rows.length) {
                return json({
                    success: false,
                    message: "Teacher not found in this school."
                }, 404);
            }

            const rows = recordType === "tests"
                ? await getTestTeacherBreakdown(
                    client,
                    sectorId,
                    schoolId,
                    teacherId,
                    testId
                )
                : await getExaminationTeacherBreakdown(
                    client,
                    sectorId,
                    schoolId,
                    teacherId,
                    academicYear,
                    termNumber
                );

            const summary = calculateSummary(rows);

            return json({
                success: true,
                record_type: recordType,
                test_id: testId,
                academic_year: academicYear,
                term_number: termNumber,
                teacher: teacherCheck.rows[0],
                breakdown: rows,
                summary
            });
        }

        return json({
            success: false,
            message: "Invalid action."
        }, 400);

    } catch (error) {
        console.error("Inspect marks recording error:", error);

        if (error.message === "UNAUTHORIZED") {
            return json({
                success: false,
                message: "Your session is invalid or has expired. Please log in again."
            }, 401);
        }

        if (error.message === "FORBIDDEN") {
            return json({
                success: false,
                message: "You are not authorised to access this information."
            }, 403);
        }

        if (error.message === "INVALID_RECORD_TYPE") {
            return json({
                success: false,
                message: "Invalid recording category."
            }, 400);
        }

        if (error.message === "INVALID_TERM") {
            return json({
                success: false,
                message: "Invalid academic term."
            }, 400);
        }

        if (error.message === "SERVER_CONFIGURATION_ERROR") {
            return json({
                success: false,
                message: "Server authentication configuration is missing."
            }, 500);
        }

        return json({
            success: false,
            message: "An error occurred while retrieving marks-recording information."
        }, 500);

    } finally {
        if (client) {
            await client.end().catch(() => {});
        }
    }
}
