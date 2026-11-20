
import {
    connectDB,
    json
} from "../_utils.js";

import { jwtVerify } from "jose";

/* =====================================================
   FILA GRADES SYSTEM
   SCHOOL ADMIN — MARKS RECORDING INSPECTION
===================================================== */

function getCookie(request, name) {
    const cookieHeader = request.headers.get("Cookie") || "";

    const cookies = cookieHeader.split(";");

    for (const cookie of cookies) {
        const [key, ...value] = cookie.trim().split("=");

        if (key === name) {
            return value.join("=");
        }
    }

    return null;
}

async function authenticateSchoolAdmin(request, env, db) {
    const token = getCookie(request, "ses_token");

    if (!token) {
        return {
            error: json({
                success: false,
                message: "Authentication required."
            }, 401)
        };
    }

    let payload;

    try {
        const secret = new TextEncoder().encode(env.JWT_SECRET);

        const verified = await jwtVerify(token, secret, {
            algorithms: ["HS256"]
        });

        payload = verified.payload;

    } catch {
        return {
            error: json({
                success: false,
                message: "Invalid or expired session."
            }, 401)
        };
    }

    if (
        payload.role !== "school_admin" ||
        !payload.sub
    ) {
        return {
            error: json({
                success: false,
                message: "Access denied."
            }, 403)
        };
    }

    const result = await db.query(
        `SELECT
            id,
            school_id,
            role,
            status
         FROM users
         WHERE id = $1
         LIMIT 1`,
        [payload.sub]
    );

    const user = result.rows[0];

    if (
        !user ||
        user.role !== "school_admin" ||
        user.status !== "active" ||
        !user.school_id
    ) {
        return {
            error: json({
                success: false,
                message: "Active School Admin account required."
            }, 403)
        };
    }

    return {
        user,
        schoolId: user.school_id
    };
}

/* =====================================================
   TESTS — TEACHER PROGRESS
===================================================== */

async function getTestTeacherProgress(db, schoolId) {
    const result = await db.query(
        `WITH teacher_base AS (
            SELECT
                t.id AS teacher_id,
                u.id AS user_id,
                u.full_name,
                u.phone
            FROM teachers t
            JOIN users u
                ON u.id = t.user_id
            WHERE t.school_id = $1
              AND u.role = 'teacher'
              AND u.status = 'active'
        ),

        assignment_counts AS (
            SELECT
                teacher_id,
                COUNT(DISTINCT class_id)::int
                    AS assigned_classes_count,
                COUNT(DISTINCT subject_id)::int
                    AS assigned_subjects_count
            FROM teacher_assignments
            WHERE school_id = $1
            GROUP BY teacher_id
        ),

        expected AS (
            SELECT
                ta.teacher_id,
                ta.class_id,
                ta.subject_id,
                t.id AS test_id,

                COUNT(DISTINCT s.id)::int
                    AS expected_marks,

                COUNT(DISTINCT m.student_id)
                    FILTER (WHERE m.id IS NOT NULL)::int
                    AS recorded_marks

            FROM teacher_assignments ta

            JOIN tests t
                ON EXISTS (
                    SELECT 1
                    FROM test_classes tc_check
                    WHERE tc_check.test_id = t.id
                      AND tc_check.school_id = ta.school_id
                      AND tc_check.class_id = ta.class_id
                )

            JOIN test_subjects ts
                ON ts.test_id = t.id
               AND ts.subject_id = ta.subject_id

            JOIN students s
                ON s.school_id = ta.school_id
               AND s.class_id = ta.class_id
               AND s.status = 'active'

            LEFT JOIN teachers teacher
                ON teacher.id = ta.teacher_id

            LEFT JOIN marks m
                ON m.test_id = t.id
               AND m.student_id = s.id
               AND m.class_id = ta.class_id
               AND m.subject_id = ta.subject_id
               AND m.recorded_by = teacher.user_id

            WHERE ta.school_id = $1
              AND t.status IN ('initiated', 'open', 'closed')

            GROUP BY
                ta.teacher_id,
                ta.class_id,
                ta.subject_id,
                t.id
        ),

        teacher_stats AS (
            SELECT
                teacher_id,
                SUM(expected_marks)::int
                    AS expected_marks,
                SUM(recorded_marks)::int
                    AS recorded_marks
            FROM expected
            GROUP BY teacher_id
        )

        SELECT
            tb.teacher_id,
            tb.full_name,
            tb.phone,

            COALESCE(ac.assigned_classes_count, 0)::int
                AS assigned_classes_count,

            COALESCE(ac.assigned_subjects_count, 0)::int
                AS assigned_subjects_count,

            COALESCE(st.expected_marks, 0)::int
                AS expected_marks,

            COALESCE(st.recorded_marks, 0)::int
                AS recorded_marks,

            GREATEST(
                COALESCE(st.expected_marks, 0) -
                COALESCE(st.recorded_marks, 0),
                0
            )::int AS missing_marks,

            CASE
                WHEN COALESCE(st.expected_marks, 0) = 0
                    THEN 0
                ELSE ROUND(
                    COALESCE(st.recorded_marks, 0)::numeric
                    * 100 /
                    st.expected_marks
                )::int
            END AS completion_percentage

        FROM teacher_base tb

        LEFT JOIN assignment_counts ac
            ON ac.teacher_id = tb.teacher_id

        LEFT JOIN teacher_stats st
            ON st.teacher_id = tb.teacher_id

        ORDER BY
            completion_percentage DESC,
            tb.full_name ASC`,
        [schoolId]
    );

    return result.rows;
}


/* =====================================================
   EXAMINATIONS — TEACHER PROGRESS
===================================================== */

async function getExaminationTeacherProgress(db, schoolId) {
    const result = await db.query(
        `WITH teacher_base AS (
            SELECT
                t.id AS teacher_id,
                u.id AS user_id,
                u.full_name,
                u.phone
            FROM teachers t
            JOIN users u
                ON u.id = t.user_id
            WHERE t.school_id = $1
              AND u.role = 'teacher'
              AND u.status = 'active'
        ),

        assignment_counts AS (
            SELECT
                teacher_id,
                COUNT(DISTINCT class_id)::int
                    AS assigned_classes_count,
                COUNT(DISTINCT subject_id)::int
                    AS assigned_subjects_count
            FROM teacher_assignments
            WHERE school_id = $1
            GROUP BY teacher_id
        ),

        expected AS (
            SELECT
                ta.teacher_id,
                ta.class_id,
                ta.subject_id,
                e.id AS examination_id,

                COUNT(DISTINCT s.id)::int
                    AS expected_marks,

                COUNT(DISTINCT m.student_id)
                    FILTER (WHERE m.id IS NOT NULL)::int
                    AS recorded_marks

            FROM teacher_assignments ta

            JOIN examinations e
                ON e.school_id = ta.school_id
               AND e.class_id = ta.class_id
               AND e.subject_id = ta.subject_id

            JOIN students s
                ON s.school_id = ta.school_id
               AND s.class_id = ta.class_id
               AND s.status = 'active'

            LEFT JOIN teachers teacher
                ON teacher.id = ta.teacher_id

            LEFT JOIN marks m
                ON m.examination_id = e.id
               AND m.student_id = s.id
               AND m.class_id = ta.class_id
               AND m.subject_id = ta.subject_id
               AND m.recorded_by = teacher.user_id

            WHERE ta.school_id = $1

            GROUP BY
                ta.teacher_id,
                ta.class_id,
                ta.subject_id,
                e.id
        ),

        teacher_stats AS (
            SELECT
                teacher_id,
                SUM(expected_marks)::int
                    AS expected_marks,
                SUM(recorded_marks)::int
                    AS recorded_marks
            FROM expected
            GROUP BY teacher_id
        )

        SELECT
            tb.teacher_id,
            tb.full_name,
            tb.phone,

            COALESCE(ac.assigned_classes_count, 0)::int
                AS assigned_classes_count,

            COALESCE(ac.assigned_subjects_count, 0)::int
                AS assigned_subjects_count,

            COALESCE(st.expected_marks, 0)::int
                AS expected_marks,

            COALESCE(st.recorded_marks, 0)::int
                AS recorded_marks,

            GREATEST(
                COALESCE(st.expected_marks, 0) -
                COALESCE(st.recorded_marks, 0),
                0
            )::int AS missing_marks,

            CASE
                WHEN COALESCE(st.expected_marks, 0) = 0
                    THEN 0
                ELSE ROUND(
                    COALESCE(st.recorded_marks, 0)::numeric
                    * 100 /
                    st.expected_marks
                )::int
            END AS completion_percentage

        FROM teacher_base tb

        LEFT JOIN assignment_counts ac
            ON ac.teacher_id = tb.teacher_id

        LEFT JOIN teacher_stats st
            ON st.teacher_id = tb.teacher_id

        ORDER BY
            completion_percentage DESC,
            tb.full_name ASC`,
        [schoolId]
    );

    return result.rows;
}

/* =====================================================
   TEACHER BREAKDOWN — TESTS
===================================================== */


/* =====================================================
   TEACHER BREAKDOWN — TESTS
===================================================== */

async function getTestTeacherBreakdown(
    db,
    schoolId,
    teacherId
) {
    const result = await db.query(
        `WITH expected AS (
            SELECT
                ta.class_id,
                ta.subject_id,
                c.class_name,
                sub.subject_name,
                t.id AS test_id,

                COUNT(DISTINCT s.id)::int
                    AS expected_marks,

                COUNT(DISTINCT m.student_id)
                    FILTER (WHERE m.id IS NOT NULL)::int
                    AS recorded_marks

            FROM teacher_assignments ta

            JOIN teachers teacher
                ON teacher.id = ta.teacher_id

            JOIN tests t
                ON EXISTS (
                    SELECT 1
                    FROM test_classes tc_check
                    WHERE tc_check.test_id = t.id
                      AND tc_check.school_id = ta.school_id
                      AND tc_check.class_id = ta.class_id
                )

            JOIN test_subjects ts
                ON ts.test_id = t.id
               AND ts.subject_id = ta.subject_id

            JOIN students s
                ON s.school_id = ta.school_id
               AND s.class_id = ta.class_id
               AND s.status = 'active'

            JOIN classes c
                ON c.id = ta.class_id

            JOIN subjects sub
                ON sub.id = ta.subject_id

            LEFT JOIN marks m
                ON m.test_id = t.id
               AND m.student_id = s.id
               AND m.class_id = ta.class_id
               AND m.subject_id = ta.subject_id
               AND m.recorded_by = teacher.user_id

            WHERE ta.school_id = $1
              AND ta.teacher_id = $2
              AND t.status IN ('initiated', 'open', 'closed')

            GROUP BY
                ta.class_id,
                ta.subject_id,
                c.class_name,
                sub.subject_name,
                t.id
        )

        SELECT
            class_id,
            subject_id,
            class_name,
            subject_name,

            SUM(expected_marks)::int
                AS expected_marks,

            SUM(recorded_marks)::int
                AS recorded_marks,

            GREATEST(
                SUM(expected_marks) -
                SUM(recorded_marks),
                0
            )::int AS missing_marks,

            CASE
                WHEN SUM(expected_marks) = 0
                    THEN 0
                ELSE ROUND(
                    SUM(recorded_marks)::numeric
                    * 100 /
                    SUM(expected_marks)
                )::int
            END AS completion_percentage

        FROM expected

        GROUP BY
            class_id,
            subject_id,
            class_name,
            subject_name

        ORDER BY
            class_name,
            subject_name`,
        [schoolId, teacherId]
    );

    return result.rows;
}


/* =====================================================
   TEACHER BREAKDOWN — EXAMINATIONS
===================================================== */

async function getExaminationTeacherBreakdown(
    db,
    schoolId,
    teacherId
) {
    const result = await db.query(
        `WITH expected AS (
            SELECT
                ta.class_id,
                ta.subject_id,
                c.class_name,
                sub.subject_name,
                e.id AS examination_id,

                COUNT(DISTINCT s.id)::int
                    AS expected_marks,

                COUNT(DISTINCT m.student_id)
                    FILTER (WHERE m.id IS NOT NULL)::int
                    AS recorded_marks

            FROM teacher_assignments ta

            JOIN teachers teacher
                ON teacher.id = ta.teacher_id

            JOIN examinations e
                ON e.school_id = ta.school_id
               AND e.class_id = ta.class_id
               AND e.subject_id = ta.subject_id

            JOIN students s
                ON s.school_id = ta.school_id
               AND s.class_id = ta.class_id
               AND s.status = 'active'

            JOIN classes c
                ON c.id = ta.class_id

            JOIN subjects sub
                ON sub.id = ta.subject_id

            LEFT JOIN marks m
                ON m.examination_id = e.id
               AND m.student_id = s.id
               AND m.class_id = ta.class_id
               AND m.subject_id = ta.subject_id
               AND m.recorded_by = teacher.user_id

            WHERE ta.school_id = $1
              AND ta.teacher_id = $2

            GROUP BY
                ta.class_id,
                ta.subject_id,
                c.class_name,
                sub.subject_name,
                e.id
        )

        SELECT
            class_id,
            subject_id,
            class_name,
            subject_name,

            SUM(expected_marks)::int
                AS expected_marks,

            SUM(recorded_marks)::int
                AS recorded_marks,

            GREATEST(
                SUM(expected_marks) -
                SUM(recorded_marks),
                0
            )::int AS missing_marks,

            CASE
                WHEN SUM(expected_marks) = 0
                    THEN 0
                ELSE ROUND(
                    SUM(recorded_marks)::numeric
                    * 100 /
                    SUM(expected_marks)
                )::int
            END AS completion_percentage

        FROM expected

        GROUP BY
            class_id,
            subject_id,
            class_name,
            subject_name

        ORDER BY
            class_name,
            subject_name`,
        [schoolId, teacherId]
    );

    return result.rows;
}

/* =====================================================
   MAIN ENDPOINT
===================================================== */

export async function onRequest(context) {
    const { request, env } = context;

    if (request.method !== "GET") {
        return json({
            success: false,
            message: "Method not allowed."
        }, 405);
    }

    let db;

    try {
        db = await connectDB(context);

        const authentication =
            await authenticateSchoolAdmin(
                request,
                env,
                db
            );

        if (authentication.error) {
            return authentication.error;
        }

        const { schoolId } = authentication;

        const url = new URL(request.url);

        const action = url.searchParams.get("action");
        const recordType = url.searchParams.get("record_type");

        if (!["tests", "examinations"].includes(recordType)) {
            return json({
                success: false,
                message: "Invalid record type."
            }, 400);
        }

        /* =============================================
           SCHOOL INFORMATION
        ============================================= */

        const schoolResult = await db.query(
            `SELECT
                id,
                school_name
             FROM schools
             WHERE id = $1
             LIMIT 1`,
            [schoolId]
        );

        const school = schoolResult.rows[0];

        if (!school) {
            return json({
                success: false,
                message: "School not found."
            }, 404);
        }

        /* =============================================
           GET TEACHER PROGRESS
        ============================================= */

        if (action === "get_teacher_progress") {
            const teachers =
                recordType === "tests"
                    ? await getTestTeacherProgress(
                        db,
                        schoolId
                    )
                    : await getExaminationTeacherProgress(
                        db,
                        schoolId
                    );

            const summary = teachers.reduce(
                (total, teacher) => {
                    total.total_teachers++;

                    total.expected_marks +=
                        Number(teacher.expected_marks || 0);

                    total.recorded_marks +=
                        Number(teacher.recorded_marks || 0);

                    total.missing_marks +=
                        Number(teacher.missing_marks || 0);

                    return total;
                },
                {
                    total_teachers: 0,
                    expected_marks: 0,
                    recorded_marks: 0,
                    missing_marks: 0
                }
            );

            return json({
                success: true,
                school: {
                    school_name: school.school_name
                },
                teachers,
                summary
            });
        }

        /* =============================================
           GET TEACHER BREAKDOWN
        ============================================= */

        if (action === "get_teacher_breakdown") {
            const teacherId =
                url.searchParams.get("teacher_id");

            if (
                !teacherId ||
                !/^\d+$/.test(teacherId)
            ) {
                return json({
                    success: false,
                    message: "A valid teacher ID is required."
                }, 400);
            }

            /* Verify teacher belongs to this school */

            const teacherResult = await db.query(
                `SELECT
                    t.id,
                    u.full_name
                 FROM teachers t
                 JOIN users u
                    ON u.id = t.user_id
                 WHERE t.id = $1
                   AND t.school_id = $2
                   AND u.role = 'teacher'
                   AND u.status = 'active'
                 LIMIT 1`,
                [teacherId, schoolId]
            );

            const teacher = teacherResult.rows[0];

            if (!teacher) {
                return json({
                    success: false,
                    message: "Teacher not found in your school."
                }, 404);
            }

            const breakdown =
                recordType === "tests"
                    ? await getTestTeacherBreakdown(
                        db,
                        schoolId,
                        teacherId
                    )
                    : await getExaminationTeacherBreakdown(
                        db,
                        schoolId,
                        teacherId
                    );

            const summary = breakdown.reduce(
                (total, item) => {
                    total.expected_marks +=
                        Number(item.expected_marks || 0);

                    total.recorded_marks +=
                        Number(item.recorded_marks || 0);

                    total.missing_marks +=
                        Number(item.missing_marks || 0);

                    return total;
                },
                {
                    expected_marks: 0,
                    recorded_marks: 0,
                    missing_marks: 0
                }
            );

            return json({
                success: true,
                teacher: {
                    teacher_id: teacher.id,
                    full_name: teacher.full_name
                },
                breakdown,
                summary
            });
        }

        return json({
            success: false,
            message: "Invalid action."
        }, 400);

    } catch (error) {
        console.error(
            "School Admin Marks Inspection Error:",
            error
        );

        return json({
            success: false,
            message: "Unable to load marks recording information."
        }, 500);

    } finally {
        if (db) {
            try {
                await db.end();
            } catch (error) {
                console.error(
                    "Database connection close error:",
                    error
                );
            }
        }
    }
}
