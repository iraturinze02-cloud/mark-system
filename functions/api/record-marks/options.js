
import {
    connectDB,
    requireTestUser,
    json
} from "../../_utils.js";

/* =====================================================
   GET: RECORD MARKS OPTIONS
===================================================== */

export async function onRequestGet(context) {
    const auth = await requireTestUser(context);

    if (auth.error) return auth.error;

    if (auth.role !== "teacher") {
        return json({
            success: false,
            message: "Only teachers can access Record Marks."
        }, 403);
    }

    let client;

    try {
        client = await connectDB(context);

        // Automatically close expired Tests assigned to this teacher.
        await client.query(
            `
            UPDATE tests t
            SET
                status = 'closed',
                closed_at = NOW(),
                updated_at = NOW()
            WHERE t.status = 'open'
              AND t.closing_at IS NOT NULL
              AND t.closing_at <= NOW()
              AND EXISTS (
                  SELECT 1
                  FROM test_classes tc
                  INNER JOIN test_subjects ts
                      ON ts.test_id = tc.test_id
                  INNER JOIN teachers tr
                      ON tr.school_id = tc.school_id
                  INNER JOIN teacher_assignments ta
                      ON ta.teacher_id = tr.id
                     AND ta.school_id = tr.school_id
                     AND ta.class_id = tc.class_id
                     AND ta.subject_id = ts.subject_id
                  WHERE tc.test_id = t.id
                    AND tr.user_id = $1
                    AND tr.school_id = $2
              )
            `,
            [auth.userId, auth.schoolId]
        );

        /* ---------------------------------------------
           1. TEACHER ASSIGNMENTS
        --------------------------------------------- */

        const assignmentsResult = await client.query(
            `
            SELECT DISTINCT
                ta.id AS assignment_id,
                ta.school_id,
                sch.school_name,
                ta.class_id,
                c.class_name,
                c.class_level,
                ta.subject_id,
                sub.subject_name,
                sub.subject_code
            FROM teachers tr
            INNER JOIN teacher_assignments ta
                ON ta.teacher_id = tr.id
               AND ta.school_id = tr.school_id
            INNER JOIN schools sch
                ON sch.id = ta.school_id
            INNER JOIN classes c
                ON c.id = ta.class_id
               AND c.school_id = ta.school_id
            INNER JOIN subjects sub
                ON sub.id = ta.subject_id
            WHERE tr.user_id = $1
              AND tr.school_id = $2
            ORDER BY c.class_name, sub.subject_name
            `,
            [auth.userId, auth.schoolId]
        );

        /* ---------------------------------------------
           2. TESTS MATCHING TEACHER ASSIGNMENTS
        --------------------------------------------- */

        const testsResult = await client.query(
            `
            SELECT DISTINCT
                ta.id AS assignment_id,

                t.id AS test_id,
                t.test_name,
                t.status,
                t.created_at,
                t.closing_at,

                t.created_by,
                creator.full_name AS creator_name,

                t.initiated_by,
                opener.full_name AS initiated_by_name,
                t.initiated_at,

                t.closed_by,
                closer.full_name AS closed_by_name,
                t.closed_at,

                tc.school_id,
                sch.school_name,

                tc.class_id,
                c.class_name,

                ts.subject_id,
                sub.subject_name,

                -- Maximum mark assigned to this Test subject
                ts.total_marks,

                CASE
                    WHEN t.status = 'open'
                     AND (
                         t.closing_at IS NULL
                         OR t.closing_at > NOW()
                     )
                    THEN TRUE
                    ELSE FALSE
                END AS available_for_marks

            FROM teachers tr

            INNER JOIN teacher_assignments ta
                ON ta.teacher_id = tr.id
               AND ta.school_id = tr.school_id

            INNER JOIN test_classes tc
                ON tc.school_id = ta.school_id
               AND tc.class_id = ta.class_id

            INNER JOIN test_subjects ts
                ON ts.test_id = tc.test_id
               AND ts.subject_id = ta.subject_id

            INNER JOIN tests t
                ON t.id = tc.test_id

            INNER JOIN schools sch
                ON sch.id = tc.school_id

            INNER JOIN classes c
                ON c.id = tc.class_id
               AND c.school_id = tc.school_id

            INNER JOIN subjects sub
                ON sub.id = ts.subject_id

            LEFT JOIN users creator
                ON creator.id = t.created_by

            LEFT JOIN users opener
                ON opener.id = t.initiated_by

            LEFT JOIN users closer
                ON closer.id = t.closed_by

            WHERE tr.user_id = $1
              AND tr.school_id = $2

            ORDER BY
                t.created_at DESC,
                c.class_name,
                sub.subject_name
            `,
            [auth.userId, auth.schoolId]
        );

        return json({
            success: true,
            teacher: {
                id: auth.userId,
                schoolId: auth.schoolId
            },
            assignments: assignmentsResult.rows,
            tests: testsResult.rows
        });

    } catch (error) {
        console.error("Record Marks options error:", error);

        return json({
            success: false,
            message: "Unable to load Record Marks options."
        }, 500);

    } finally {
        if (client) {
            await client.end().catch(() => {});
        }
    }
}
