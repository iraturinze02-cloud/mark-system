
import {
    connectDB,
    requireTestUser,
    json
} from "../../_utils.js";

function validId(value) {
    const id = String(value ?? "").trim();
    return /^\d+$/.test(id) && Number(id) > 0 ? id : null;
}

export async function onRequestPost(context) {
    const auth = await requireTestUser(context);

    if (auth.error) return auth.error;

    if (auth.role !== "teacher") {
        return json({
            success: false,
            message: "Only teachers can save marks."
        }, 403);
    }

    let data;

    try {
        data = await context.request.json();
    } catch {
        return json({
            success: false,
            message: "Invalid JSON request."
        }, 400);
    }

    const type = data.assessment_type;
    const assessmentId = validId(data.assessment_id);
    const assignmentId = validId(data.assignment_id);

    if (
        !["test", "examination"].includes(type) ||
        !assessmentId ||
        !assignmentId ||
        !Array.isArray(data.marks) ||
        data.marks.length === 0
    ) {
        return json({
            success: false,
            message: "Invalid marks submission."
        }, 400);
    }

    if (data.marks.length > 1000) {
        return json({
            success: false,
            message: "Too many student marks in one submission."
        }, 400);
    }

    /* ---------------------------------------------
       VALIDATE MARK VALUES AND STUDENT IDS
    --------------------------------------------- */

    const submittedMarks = [];
    const seenStudents = new Set();

    for (const item of data.marks) {
        const studentId = validId(item.student_id);

        if (!studentId) {
            return json({
                success: false,
                message: "An invalid student was submitted."
            }, 400);
        }

        if (seenStudents.has(studentId)) {
            return json({
                success: false,
                message: "A student appears more than once."
            }, 400);
        }

        seenStudents.add(studentId);

        /*
         * Blank entries are ignored. This allows a teacher
         * to save marks for only the students entered.
         */

        if (
            item.mark === null ||
            item.mark === undefined ||
            String(item.mark).trim() === ""
        ) {
            continue;
        }

        const score = Number(item.mark);

        if (!Number.isFinite(score) || score < 0) {
            return json({
                success: false,
                message: "Marks must be valid non-negative numbers."
            }, 400);
        }

        submittedMarks.push({
            student_id: studentId,
            score
        });
    }

    if (submittedMarks.length === 0) {
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
           VERIFY TEACHER ASSIGNMENT
        --------------------------------------------- */

        const assignmentResult = await client.query(
            `
            SELECT
                ta.id,
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
                message: "You are not authorized for this class and subject."
            }, 403);
        }

        const assignment = assignmentResult.rows[0];

        /* ---------------------------------------------
           VERIFY TEST OR EXAMINATION
        --------------------------------------------- */

        let examinationId;
        let totalMarks;

        if (type === "test") {
            const testResult = await client.query(
                `
                SELECT
                    t.id,
                    t.status,
                    t.closing_at,
                    te.examination_id,
                    e.total_marks,
                    e.school_id,
                    e.class_id,
                    e.subject_id
                FROM tests t
                INNER JOIN test_classes tc
                    ON tc.test_id = t.id
                INNER JOIN test_subjects ts
                    ON ts.test_id = t.id
                LEFT JOIN test_examinations te
                    ON te.test_id = t.id
                LEFT JOIN examinations e
                    ON e.id = te.examination_id
                WHERE t.id = $1
                  AND tc.school_id = $2
                  AND tc.class_id = $3
                  AND ts.subject_id = $4
                FOR UPDATE OF t
                `,
                [
                    assessmentId,
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
                    message: "This Test is not assigned to your class and subject."
                }, 403);
            }

            const test = testResult.rows[0];

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
                        closed_by = NULL,
                        updated_at = NOW()
                    WHERE id = $1
                      AND status = 'open'
                    `,
                    [assessmentId]
                );

                await client.query("COMMIT");
                transactionStarted = false;

                return json({
                    success: false,
                    message: "This Test has reached its closing time."
                }, 403);
            }

            if (test.status !== "open") {
                await client.query("ROLLBACK");
                transactionStarted = false;

                return json({
                    success: false,
                    message: "Marks can only be recorded while the Test is open."
                }, 403);
            }

            if (!test.examination_id || !test.total_marks) {
                await client.query("ROLLBACK");
                transactionStarted = false;

                return json({
                    success: false,
                    message: "This Test has no valid connected Examination yet."
                }, 409);
            }

            if (
                String(test.school_id) !== String(assignment.school_id) ||
                String(test.class_id) !== String(assignment.class_id) ||
                String(test.subject_id) !== String(assignment.subject_id)
            ) {
                await client.query("ROLLBACK");
                transactionStarted = false;

                return json({
                    success: false,
                    message: "The connected Examination does not match this assignment."
                }, 409);
            }

            examinationId = test.examination_id;
            totalMarks = Number(test.total_marks);

        } else {
            const examResult = await client.query(
                `
                SELECT
                    id,
                    total_marks
                FROM examinations
                WHERE id = $1
                  AND school_id = $2
                  AND class_id = $3
                  AND subject_id = $4
                FOR UPDATE
                `,
                [
                    assessmentId,
                    assignment.school_id,
                    assignment.class_id,
                    assignment.subject_id
                ]
            );

            if (examResult.rows.length === 0) {
                await client.query("ROLLBACK");
                transactionStarted = false;

                return json({
                    success: false,
                    message: "This Examination is not assigned to your class and subject."
                }, 403);
            }

            examinationId = examResult.rows[0].id;
            totalMarks = Number(examResult.rows[0].total_marks);
        }

        /* ---------------------------------------------
           VALIDATE SCORES AGAINST MAXIMUM MARKS
        --------------------------------------------- */

        for (const item of submittedMarks) {
            if (item.score > totalMarks) {
                await client.query("ROLLBACK");
                transactionStarted = false;

                return json({
                    success: false,
                    message: `A mark cannot exceed ${totalMarks}.`
                }, 400);
            }
        }

        /* ---------------------------------------------
           VERIFY ALL STUDENTS BELONG TO THIS CLASS
        --------------------------------------------- */

        const studentIds = submittedMarks.map(
            item => item.student_id
        );

        const studentsResult = await client.query(
            `
            SELECT id
            FROM students
            WHERE id = ANY($1::bigint[])
              AND school_id = $2
              AND class_id = $3
            `,
            [
                studentIds,
                assignment.school_id,
                assignment.class_id
            ]
        );

        if (studentsResult.rows.length !== submittedMarks.length) {
            await client.query("ROLLBACK");
            transactionStarted = false;

            return json({
                success: false,
                message: "One or more students do not belong to your assigned class."
            }, 403);
        }

        /* ---------------------------------------------
           SAVE TO THE EXISTING MARKS TABLE
        --------------------------------------------- */

        let savedCount = 0;

        for (const item of submittedMarks) {
            await client.query(
                `
                INSERT INTO marks (
                    examination_id,
                    student_id,
                    class_id,
                    score,
                    recorded_by,
                    created_at,
                    updated_at
                )
                VALUES ($1, $2, $3, $4, $5, NOW(), NOW())

                ON CONFLICT (examination_id, student_id)
                DO UPDATE SET
                    score = EXCLUDED.score,
                    recorded_by = EXCLUDED.recorded_by,
                    updated_at = NOW()
                `,
                [
                    examinationId,
                    item.student_id,
                    assignment.class_id,
                    item.score,
                    auth.userId
                ]
            );

            savedCount++;
        }

        await client.query("COMMIT");
        transactionStarted = false;

        return json({
            success: true,
            message: "Marks saved successfully.",
            saved_count: savedCount,
            total_marks: totalMarks
        });

    } catch (error) {
        if (client && transactionStarted) {
            await client.query("ROLLBACK").catch(() => {});
        }

        console.error("Save marks error:", error);

        return json({
            success: false,
            message: "Unable to save marks."
        }, 500);

    } finally {
        if (client) {
            await client.end().catch(() => {});
        }
    }
}
