
import {
    connectDB,
    requireTestUser,
    json
} from "../../_utils.js";

/* =====================================================
   HELPERS
===================================================== */

function positiveId(value) {
    const id = Number(value);

    return Number.isSafeInteger(id) && id > 0
        ? id
        : null;
}

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

    const url = new URL(context.request.url);

    const academicYearId = positiveId(
        url.searchParams.get("academic_year_id")
    );

    const termId = positiveId(
        url.searchParams.get("term_id")
    );

    if (!academicYearId || !termId) {
        return json({
            success: false,
            message: "Please select a valid academic year and term."
        }, 400);
    }

    let client;

    try {
        client = await connectDB(context);

        /* ---------------------------------------------
           1. VERIFY SELECTED ACADEMIC PERIOD
        --------------------------------------------- */

        const periodResult = await client.query(
            `
            SELECT
                ay.id AS academic_year_id,
                ay.year_name AS academic_year,

                tm.id AS term_id,
                tm.term_number,
                tm.term_name

            FROM academic_years ay

            INNER JOIN terms tm
                ON tm.academic_year_id = ay.id
               AND tm.school_id = ay.school_id

            WHERE ay.id = $1
              AND ay.school_id = $2
              AND tm.id = $3

            LIMIT 1
            `,
            [
                academicYearId,
                auth.schoolId,
                termId
            ]
        );

        if (periodResult.rows.length === 0) {
            return json({
                success: false,
                message: "The selected academic year and term are invalid for your school."
            }, 400);
        }

        const academicPeriod = periodResult.rows[0];

        /* ---------------------------------------------
           2. AUTOMATICALLY CLOSE EXPIRED TESTS

           Preserve existing behavior.
        --------------------------------------------- */

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
            [
                auth.userId,
                auth.schoolId
            ]
        );

        /* ---------------------------------------------
           3. LOAD TEACHER ASSIGNMENTS

           Do not filter by ta.academic_year_id or
           ta.term_id because existing assignments
           currently have NULL in those columns.
        --------------------------------------------- */

        const assignmentsResult = await client.query(
            `
            SELECT DISTINCT
                ta.id AS assignment_id,
                ta.school_id,
                sch.school_name,

                ta.class_id,
                c.class_name,
                c.level_id,

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

            INNER JOIN subjects sub
                ON sub.id = ta.subject_id

            WHERE tr.user_id = $1
              AND tr.school_id = $2

            ORDER BY
                c.class_name,
                sub.subject_name
            `,
            [
                auth.userId,
                auth.schoolId
            ]
        );

        /* ---------------------------------------------
           4. LOAD TESTS FOR SELECTED PERIOD ONLY
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

                ts.total_marks,

                tsc.academic_year_id,
                tsc.term_id,

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

            INNER JOIN test_schools tsc
                ON tsc.test_id = tc.test_id
               AND tsc.school_id = tc.school_id
               AND tsc.academic_year_id = $3
               AND tsc.term_id = $4

            INNER JOIN tests t
                ON t.id = tc.test_id

            INNER JOIN schools sch
                ON sch.id = tc.school_id

            INNER JOIN classes c
                ON c.id = tc.class_id

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
            [
                auth.userId,
                auth.schoolId,
                academicYearId,
                termId
            ]
        );

        /* ---------------------------------------------
           5. RETURN OPTIONS
        --------------------------------------------- */

        return json({
            success: true,

            teacher: {
                id: auth.userId,
                schoolId: auth.schoolId
            },

            academic_period: academicPeriod,

            assignments: assignmentsResult.rows,
            tests: testsResult.rows
        });

    } catch (error) {
        console.error(
            "Record Marks options error:",
            error
        );

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
