
import { connectDB, json } from "../_utils.js";
import { jwtVerify } from "jose";

/* =====================================================
   FILA GRADES SYSTEM
   SECTOR ADMIN — INSPECT MARKS RECORDING API

   GET /api/inspect-marks-recording?action=get_school_progress
   GET /api/inspect-marks-recording?action=get_teacher_progress
   GET /api/inspect-marks-recording?action=get_teacher_breakdown

   Supported record_type:
   - tests
   - examinations
===================================================== */


/* =====================================================
   AUTHENTICATION
===================================================== */

function getCookie(request, name) {
    const cookieHeader = request.headers.get("Cookie") || "";

    const cookies = cookieHeader.split(";");

    for (const cookie of cookies) {
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


/* =====================================================
   SCHOOL PROGRESS — TESTS
===================================================== */

async function getTestSchoolProgress(client, sectorId) {
    const result = await client.query(
        `
        WITH expected AS (
            SELECT
                tc.school_id,
                t.id AS test_id,
                tc.class_id,
                ts.subject_id,
                st.id AS student_id
            FROM tests t
            INNER JOIN test_classes tc
                ON tc.test_id = t.id
            INNER JOIN test_subjects ts
                ON ts.test_id = t.id
            INNER JOIN schools s
                ON s.id = tc.school_id
                AND s.sector_id = $1
            INNER JOIN students st
                ON st.school_id = tc.school_id
                AND st.class_id = tc.class_id
                AND st.status = 'active'
            WHERE t.sector_id = $1
              AND LOWER(t.status) IN ('initiated', 'open', 'closed')
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

        teacher_counts AS (
            SELECT
                t.school_id,
                COUNT(DISTINCT t.id)::int AS teacher_count
            FROM teachers t
            INNER JOIN users u
                ON u.id = t.user_id
            WHERE u.role = 'teacher'
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
        [sectorId]
    );

    return result.rows;
}


/* =====================================================
   SCHOOL PROGRESS — EXAMINATIONS
===================================================== */

async function getExaminationSchoolProgress(client, sectorId) {
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
        [sectorId]
    );

    return result.rows;
}


/* =====================================================
   TEACHER PROGRESS — TESTS
===================================================== */

async function getTestTeacherProgress(client, sectorId, schoolId) {
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
            SELECT
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
            INNER JOIN tests
                ON tests.id = tc.test_id
                AND tests.sector_id = $1
                AND LOWER(tests.status) IN ('initiated', 'open', 'closed')
            INNER JOIN test_subjects ts
                ON ts.test_id = tests.id
                AND ts.subject_id = a.subject_id
            INNER JOIN students st
                ON st.school_id = a.school_id
                AND st.class_id = a.class_id
                AND st.status = 'active'
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
        [sectorId, schoolId]
    );

    return result.rows;
}


/* =====================================================
   TEACHER PROGRESS — EXAMINATIONS
===================================================== */

async function getExaminationTeacherProgress(client, sectorId, schoolId) {
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
            SELECT
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
        [sectorId, schoolId]
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
    teacherId
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
            SELECT
                a.class_id,
                a.subject_id,
                a.user_id,
                tests.id AS test_id,
                st.id AS student_id
            FROM assignment_scope a
            INNER JOIN test_classes tc
                ON tc.school_id = a.school_id
                AND tc.class_id = a.class_id
            INNER JOIN tests
                ON tests.id = tc.test_id
                AND tests.sector_id = $1
                AND LOWER(tests.status) IN ('initiated', 'open', 'closed')
            INNER JOIN test_subjects ts
                ON ts.test_id = tests.id
                AND ts.subject_id = a.subject_id
            INNER JOIN students st
                ON st.school_id = a.school_id
                AND st.class_id = a.class_id
                AND st.status = 'active'
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
        [sectorId, schoolId, teacherId]
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
    teacherId
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
            SELECT
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
        [sectorId, schoolId, teacherId]
    );

    return result.rows;
}


/* =====================================================
   SUMMARY HELPERS
===================================================== */

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
           ACTION 1: SCHOOL PROGRESS
        --------------------------------------------- */

        if (action === "get_school_progress") {
            const rows = recordType === "tests"
                ? await getTestSchoolProgress(client, sectorId)
                : await getExaminationSchoolProgress(client, sectorId);

            const summary = calculateSummary(
                rows,
                "total_schools"
            );

            return json({
                success: true,
                record_type: recordType,
                schools: rows,
                summary
            });
        }

        /* ---------------------------------------------
           ACTION 2: TEACHER PROGRESS
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
                SELECT id, school_name
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
                    schoolId
                )
                : await getExaminationTeacherProgress(
                    client,
                    sectorId,
                    schoolId
                );

            const summary = calculateSummary(rows);
            summary.total_teachers = rows.length;

            return json({
                success: true,
                record_type: recordType,
                school: schoolCheck.rows[0],
                teachers: rows,
                summary
            });
        }

        /* ---------------------------------------------
           ACTION 3: TEACHER CLASS/SUBJECT BREAKDOWN
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
                    teacherId
                )
                : await getExaminationTeacherBreakdown(
                    client,
                    sectorId,
                    schoolId,
                    teacherId
                );

            const summary = calculateSummary(rows);

            return json({
                success: true,
                record_type: recordType,
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
