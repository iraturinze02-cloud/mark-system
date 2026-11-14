
import {
    connectDB,
    requireTestUser,
    json
} from "../../_utils.js";

/* =====================================================
   GET: STUDENTS FOR A SELECTED TEST
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

    const testId = Number(
        url.searchParams.get("test_id") ||
        url.searchParams.get("assessment_id")
    );

    const assignmentId = Number(
        url.searchParams.get("assignment_id")
    );

    if (
        !Number.isInteger(testId) || testId <= 0 ||
        !Number.isInteger(assignmentId) || assignmentId <= 0
    ) {
        return json({
            success: false,
            message: "A valid Test and assignment are required."
        }, 400);
    }

    let client;

    try {
        client = await connectDB(context);

        /* ---------------------------------------------
           1. VERIFY TEACHER ASSIGNMENT
        --------------------------------------------- */

        const assignmentResult = await client.query(
            `
            SELECT
                ta.id AS assignment_id,
                ta.school_id,
                ta.class_id,
                ta.subject_id,
                c.class_name,
                sub.subject_name
            FROM teacher_assignments ta
            INNER JOIN teachers tr
                ON tr.id = ta.teacher_id
               AND tr.school_id = ta.school_id
            INNER JOIN classes c
                ON c.id = ta.class_id
               AND c.school_id = ta.school_id
            INNER JOIN subjects sub
                ON sub.id = ta.subject_id
            WHERE ta.id = $1
              AND tr.user_id = $2
              AND tr.school_id = $3
            LIMIT 1
            `,
            [assignmentId, auth.userId, auth.schoolId]
        );

        if (assignmentResult.rows.length === 0) {
            return json({
                success: false,
                message: "This class and subject are not assigned to you."
            }, 403);
        }

        const assignment = assignmentResult.rows[0];

        /* ---------------------------------------------
           2. VERIFY TEST MATCHES ASSIGNMENT
              AND GET MAXIMUM MARK
        --------------------------------------------- */

        const testResult = await client.query(
            `
            SELECT
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

                ts.subject_id,
                ts.total_marks

            FROM tests t

            INNER JOIN test_classes tc
                ON tc.test_id = t.id
               AND tc.school_id = $2
               AND tc.class_id = $3

            INNER JOIN test_subjects ts
                ON ts.test_id = t.id
               AND ts.subject_id = $4

            LEFT JOIN users creator
                ON creator.id = t.created_by

            LEFT JOIN users opener
                ON opener.id = t.initiated_by

            LEFT JOIN users closer
                ON closer.id = t.closed_by

            WHERE t.id = $1
            LIMIT 1
            `,
            [
                testId,
                assignment.school_id,
                assignment.class_id,
                assignment.subject_id
            ]
        );

        if (testResult.rows.length === 0) {
            return json({
                success: false,
                message: "This Test does not belong to the selected class and subject."
            }, 403);
        }

        const test = testResult.rows[0];

        /* ---------------------------------------------
           3. VERIFY MAXIMUM MARK
        --------------------------------------------- */

        if (
            test.total_marks === null ||
            test.total_marks === undefined ||
            !Number.isFinite(Number(test.total_marks)) ||
            Number(test.total_marks) <= 0
        ) {
            return json({
                success: false,
                message: "The maximum mark for this Test subject has not been configured. Please contact the Test administrator."
            }, 400);
        }

        /* ---------------------------------------------
           4. AUTOMATIC CLOSING TIME CHECK
        --------------------------------------------- */

        if (
            test.status === "open" &&
            test.closing_at &&
            new Date(test.closing_at).getTime() <= Date.now()
        ) {
            await client.query(
                `
                UPDATE tests
                SET
                    status = 'closed',
                    closed_at = NOW(),
                    updated_at = NOW()
                WHERE id = $1
                  AND status = 'open'
                  AND closing_at <= NOW()
                `,
                [testId]
            );

            return json({
                success: false,
                message: "This Test has reached its closing time and is now closed."
            }, 403);
        }

        if (test.status !== "open") {
            return json({
                success: false,
                message: "Marks cannot be recorded because this Test is not open.",
                test
            }, 403);
        }

        /* ---------------------------------------------
           5. LOAD STUDENTS AND EXISTING TEST MARKS
        --------------------------------------------- */

        const studentsResult = await client.query(
            `
            SELECT
                s.id AS student_id,
                s.student_code,
                s.full_name,
                s.gender,

                m.id AS mark_id,
                m.score AS mark,
                m.remarks

            FROM students s

            LEFT JOIN marks m
                ON m.test_id = $1
               AND m.student_id = s.id
               AND m.class_id = s.class_id
               AND m.subject_id = $4

            WHERE s.school_id = $2
              AND s.class_id = $3

            ORDER BY s.full_name
            `,
            [
                testId,
                assignment.school_id,
                assignment.class_id,
                assignment.subject_id
            ]
        );

        /* ---------------------------------------------
           6. RETURN DATA
        --------------------------------------------- */

        return json({
            success: true,

            test: {
                ...test,
                total_marks: Number(test.total_marks)
            },

            assignment,

            students: studentsResult.rows
        });

    } catch (error) {
        console.error("Record Marks students error:", error);

        return json({
            success: false,
            message: "Unable to load students for this Test."
        }, 500);

    } finally {
        if (client) {
            await client.end().catch(() => {});
        }
    }
}
