
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

    if (auth.error) {
        return auth.error;
    }

    if (auth.role !== "teacher") {
        return json({
            success: false,
            message: "Only teachers can access Record Marks."
        }, 403);
    }

    let client;

    try {
        client = await connectDB(context);

        /* ---------------------------------------------
           1. LOAD TEACHER ASSIGNMENTS
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
            ORDER BY
                c.class_name,
                sub.subject_name
            `,
            [auth.userId, auth.schoolId]
        );

        const assignments = assignmentsResult.rows;

        if (assignments.length === 0) {
            return json({
                success: true,
                assignments: [],
                tests: [],
                examinations: [],
                message: "No class and subject assignments were found."
            });
        }

        /* ---------------------------------------------
           2. LOAD TESTS MATCHING ASSIGNMENTS

           Tests remain separate from Examinations.

           A Test is ready for marks only when:
           - It is open.
           - It has a mapped Examination.
           - The mapped Examination matches the
             assigned school, class and subject.
        --------------------------------------------- */

        const testsResult = await client.query(
            `
            SELECT DISTINCT
                t.id AS test_id,
                t.test_name,
                t.status,
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

                tsu.subject_id,
                sub.subject_name,

                te.examination_id,

                CASE
                    WHEN t.status <> 'open'
                        THEN FALSE

                    WHEN e.id IS NULL
                        THEN FALSE

                    WHEN e.school_id <> tc.school_id
                        THEN FALSE

                    WHEN e.class_id <> tc.class_id
                        THEN FALSE

                    WHEN e.subject_id <> tsu.subject_id
                        THEN FALSE

                    ELSE TRUE
                END AS ready_for_marks,

                CASE
                    WHEN t.status <> 'open'
                        THEN 'Test is not open'

                    WHEN e.id IS NULL
                        THEN 'No Examination record is connected'

                    WHEN e.school_id <> tc.school_id
                      OR e.class_id <> tc.class_id
                      OR e.subject_id <> tsu.subject_id
                        THEN 'Connected Examination does not match this assignment'

                    ELSE 'Ready'
                END AS availability_message,

                e.total_marks

            FROM teachers tr

            INNER JOIN teacher_assignments ta
                ON ta.teacher_id = tr.id
               AND ta.school_id = tr.school_id

            INNER JOIN test_classes tc
                ON tc.class_id = ta.class_id
               AND tc.school_id = ta.school_id

            INNER JOIN test_subjects tsu
                ON tsu.test_id = tc.test_id
               AND tsu.subject_id = ta.subject_id

            INNER JOIN tests t
                ON t.id = tc.test_id

            INNER JOIN schools sch
                ON sch.id = tc.school_id

            INNER JOIN classes c
                ON c.id = tc.class_id
               AND c.school_id = tc.school_id

            INNER JOIN subjects sub
                ON sub.id = tsu.subject_id

            LEFT JOIN users creator
                ON creator.id = t.created_by

            LEFT JOIN users opener
                ON opener.id = t.initiated_by

            LEFT JOIN users closer
                ON closer.id = t.closed_by

            LEFT JOIN test_examinations te
                ON te.test_id = t.id

            LEFT JOIN examinations e
                ON e.id = te.examination_id

            WHERE tr.user_id = $1
              AND tr.school_id = $2

            ORDER BY
                t.created_at DESC,
                c.class_name,
                sub.subject_name
            `,
            [auth.userId, auth.schoolId]
        );

        /* ---------------------------------------------
           3. LOAD EXISTING EXAMINATIONS

           Only examinations matching the teacher's
           assigned school, class and subject.
        --------------------------------------------- */

        const examinationsResult = await client.query(
            `
            SELECT DISTINCT
                e.id AS examination_id,
                e.exam_name,
                e.exam_type,
                e.school_id,
                sch.school_name,
                e.class_id,
                c.class_name,
                e.subject_id,
                sub.subject_name,
                e.total_marks,
                e.exam_date,
                e.academic_year_id,
                ay.year_name,
                e.term_id,
                tm.term_name

            FROM teachers tr

            INNER JOIN teacher_assignments ta
                ON ta.teacher_id = tr.id
               AND ta.school_id = tr.school_id

            INNER JOIN examinations e
                ON e.school_id = ta.school_id
               AND e.class_id = ta.class_id
               AND e.subject_id = ta.subject_id

            INNER JOIN schools sch
                ON sch.id = e.school_id

            INNER JOIN classes c
                ON c.id = e.class_id
               AND c.school_id = e.school_id

            INNER JOIN subjects sub
                ON sub.id = e.subject_id

            LEFT JOIN academic_years ay
                ON ay.id = e.academic_year_id
               AND ay.school_id = e.school_id

            LEFT JOIN terms tm
                ON tm.id = e.term_id
               AND tm.academic_year_id = e.academic_year_id
               AND tm.school_id = e.school_id

            WHERE tr.user_id = $1
              AND tr.school_id = $2

            ORDER BY
                e.exam_date DESC NULLS LAST,
                e.exam_name
            `,
            [auth.userId, auth.schoolId]
        );

        return json({
            success: true,

            teacher: {
                id: auth.userId,
                schoolId: auth.schoolId
            },

            assignments,
            tests: testsResult.rows,
            examinations: examinationsResult.rows
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
