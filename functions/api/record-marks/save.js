
import {
    connectDB,
    requireTestUser,
    json
} from "../../_utils.js";

/* =====================================================
   POST: SAVE TEST MARKS
===================================================== */

export async function onRequestPost(context) {
    const auth = await requireTestUser(context);

    if (auth.error) return auth.error;

    if (auth.role !== "teacher") {
        return json({
            success: false,
            message: "Only teachers can record marks."
        }, 403);
    }

    let body;

    try {
        body = await context.request.json();
    } catch {
        return json({
            success: false,
            message: "Invalid request data."
        }, 400);
    }

    const testId = Number(body.test_id || body.assessment_id);
    const assignmentId = Number(body.assignment_id);
    const submittedMarks = body.marks;

    if (
        !Number.isInteger(testId) || testId <= 0 ||
        !Number.isInteger(assignmentId) || assignmentId <= 0 ||
        !Array.isArray(submittedMarks) ||
        submittedMarks.length === 0 ||
        submittedMarks.length > 1000
    ) {
        return json({
            success: false,
            message: "Please provide a valid Test, assignment and marks."
        }, 400);
    }

    const marks = [];
    const seenStudents = new Set();

    for (const item of submittedMarks) {
        if (!item || typeof item !== "object") {
            return json({
                success: false,
                message: "Invalid student mark data."
            }, 400);
        }

        const studentId = Number(item.student_id);

        if (!Number.isInteger(studentId) || studentId <= 0) {
            return json({
                success: false,
                message: "Invalid student selected."
            }, 400);
        }

        if (seenStudents.has(studentId)) {
            return json({
                success: false,
                message: "A student appears more than once."
            }, 400);
        }

        seenStudents.add(studentId);

        // Empty scores are skipped, allowing partially completed class lists.
        if (
            item.score === null ||
            item.score === undefined ||
            String(item.score).trim() === ""
        ) {
            continue;
        }

        const score = Number(item.score);

        if (!Number.isFinite(score) || score < 0) {
            return json({
                success: false,
                message: "Marks must be valid non-negative numbers."
            }, 400);
        }

        marks.push({
            studentId,
            score,
            remarks: item.remarks == null
                ? null
                : String(item.remarks).trim()
        });
    }

    if (marks.length === 0) {
        return json({
            success: false,
            message: "Enter at least one student's mark."
        }, 400);
    }

    let client;
    let transactionStarted = false;

    try {
        client = await connectDB(context);

        await client.query("BEGIN");
        transactionStarted = true;

        /* ---------------------------------------------
           1. VERIFY TEACHER ASSIGNMENT
        --------------------------------------------- */

        const assignmentResult = await client.query(
            `
            SELECT
                ta.id AS assignment_id,
                ta.school_id,
                ta.class_id,
                ta.subject_id
            FROM teacher_assignments ta
            INNER JOIN teachers tr
                ON tr.id = ta.teacher_id
               AND tr.school_id = ta.school_id
            WHERE ta.id = $1
              AND tr.user_id = $2
              AND tr.school_id = $3
            LIMIT 1
            `,
            [assignmentId, auth.userId, auth.schoolId]
        );

        if (assignmentResult.rows.length === 0) {
            await client.query("ROLLBACK");
            transactionStarted = false;

            return json({
                success: false,
                message: "This class and subject are not assigned to you."
            }, 403);
        }

        const assignment = assignmentResult.rows[0];

        /* ---------------------------------------------
           2. LOCK AND VERIFY TEST
        --------------------------------------------- */

        const testResult = await client.query(
            `
            SELECT
                t.id,
                t.test_name,
                t.status,
                t.closing_at
            FROM tests t
            INNER JOIN test_classes tc
                ON tc.test_id = t.id
               AND tc.school_id = $2
               AND tc.class_id = $3
            INNER JOIN test_subjects ts
                ON ts.test_id = t.id
               AND ts.subject_id = $4
            WHERE t.id = $1
            FOR UPDATE OF t
            `,
            [
                testId,
                assignment.school_id,
                assignment.class_id,
                assignment.subject_id
            ]
        );

        if (testResult.rows.length === 0) {
            await client.query("ROLLBACK");
            transactionStarted = false;

            return json({
                success: false,
                message: "This Test does not match the selected class and subject."
            }, 403);
        }

        const test = testResult.rows[0];

        if (test.status !== "open") {
            await client.query("ROLLBACK");
            transactionStarted = false;

            return json({
                success: false,
                message: "This Test is not open. Marks cannot be recorded."
            }, 403);
        }

        if (
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
                `,
                [testId]
            );

            await client.query("COMMIT");
            transactionStarted = false;

            return json({
                success: false,
                message: "This Test has reached its closing time and is now closed."
            }, 403);
        }

        /* ---------------------------------------------
           3. VERIFY ALL STUDENTS BELONG TO THIS CLASS
        --------------------------------------------- */

        const studentIds = marks.map(item => item.studentId);

        const studentsResult = await client.query(
            `
            SELECT id
            FROM students
            WHERE school_id = $1
              AND class_id = $2
              AND id = ANY($3::bigint[])
            `,
            [
                assignment.school_id,
                assignment.class_id,
                studentIds
            ]
        );

        if (studentsResult.rows.length !== studentIds.length) {
            await client.query("ROLLBACK");
            transactionStarted = false;

            return json({
                success: false,
                message: "One or more students do not belong to this class."
            }, 400);
        }

        /* ---------------------------------------------
           4. SAVE OR UPDATE TEST MARKS
        --------------------------------------------- */

        let savedCount = 0;

        for (const item of marks) {
            await client.query(
                `
                INSERT INTO marks (
                    examination_id,
                    test_id,
                    student_id,
                    class_id,
                    subject_id,
                    score,
                    remarks,
                    recorded_by,
                    created_at,
                    updated_at
                )
                VALUES (
                    NULL,
                    $1,
                    $2,
                    $3,
                    $4,
                    $5,
                    $6,
                    $7,
                    NOW(),
                    NOW()
                )
                ON CONFLICT (
                    test_id,
                    student_id,
                    subject_id
                )
                WHERE test_id IS NOT NULL
                DO UPDATE SET
                    score = EXCLUDED.score,
                    remarks = EXCLUDED.remarks,
                    recorded_by = EXCLUDED.recorded_by,
                    updated_at = NOW()
                `,
                [
                    testId,
                    item.studentId,
                    assignment.class_id,
                    assignment.subject_id,
                    item.score,
                    item.remarks,
                    auth.userId
                ]
            );

            savedCount++;
        }

        await client.query("COMMIT");
        transactionStarted = false;

        return json({
            success: true,
            message: "Test marks saved successfully.",
            saved_count: savedCount,
            test_id: testId
        });

    } catch (error) {
        if (client && transactionStarted) {
            await client.query("ROLLBACK").catch(() => {});
        }

        console.error("Record Marks save error:", error);

        return json({
            success: false,
            message: "Unable to save Test marks."
        }, 500);

    } finally {
        if (client) {
            await client.end().catch(() => {});
        }
    }
}
