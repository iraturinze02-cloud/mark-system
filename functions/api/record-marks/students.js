
import {
    connectDB,
    requireTestUser,
    json
} from "../../_utils.js";

function validId(value) {
    const id = String(value ?? "").trim();
    return /^\d+$/.test(id) && Number(id) > 0 ? id : null;
}

export async function onRequestGet(context) {
    const auth = await requireTestUser(context);

    if (auth.error) return auth.error;

    if (auth.role !== "teacher") {
        return json({
            success: false,
            message: "Only teachers can load students."
        }, 403);
    }

    const params = new URL(context.request.url).searchParams;

    const type = params.get("assessment_type");
    const assessmentId = validId(params.get("assessment_id"));
    const assignmentId = validId(params.get("assignment_id"));

    if (
        !["test", "examination"].includes(type) ||
        !assessmentId ||
        !assignmentId
    ) {
        return json({
            success: false,
            message: "Invalid assessment or assignment selection."
        }, 400);
    }

    let client;

    try {
        client = await connectDB(context);

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
            return json({
                success: false,
                message: "You are not authorized for this class and subject."
            }, 403);
        }

        const assignment = assignmentResult.rows[0];

        /* ---------------------------------------------
           FIND THE CONNECTED EXAMINATION

           Both Tests and Examinations use the existing
           marks table through examination_id.
        --------------------------------------------- */

        let examinationId;
        let totalMarks;
        let assessmentName;

        if (type === "test") {
            const testResult = await client.query(
                `
                SELECT
                    t.id,
                    t.test_name,
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
                LIMIT 1
                `,
                [
                    assessmentId,
                    assignment.school_id,
                    assignment.class_id,
                    assignment.subject_id
                ]
            );

            if (testResult.rows.length === 0) {
                return json({
                    success: false,
                    message: "This Test is not assigned to your class and subject."
                }, 403);
            }

            const test = testResult.rows[0];

            /* Automatically close an expired Test. */

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

                return json({
                    success: false,
                    message: "This Test has reached its closing time."
                }, 403);
            }

            if (test.status !== "open") {
                return json({
                    success: false,
                    message: "Marks can only be recorded while the Test is open."
                }, 403);
            }

            if (!test.examination_id || !test.total_marks) {
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
                return json({
                    success: false,
                    message: "The connected Examination does not match this assignment."
                }, 409);
            }

            examinationId = test.examination_id;
            totalMarks = Number(test.total_marks);
            assessmentName = test.test_name;

        } else {
            const examResult = await client.query(
                `
                SELECT
                    id,
                    exam_name,
                    total_marks
                FROM examinations
                WHERE id = $1
                  AND school_id = $2
                  AND class_id = $3
                  AND subject_id = $4
                LIMIT 1
                `,
                [
                    assessmentId,
                    assignment.school_id,
                    assignment.class_id,
                    assignment.subject_id
                ]
            );

            if (examResult.rows.length === 0) {
                return json({
                    success: false,
                    message: "This Examination is not assigned to your class and subject."
                }, 403);
            }

            const exam = examResult.rows[0];

            examinationId = exam.id;
            totalMarks = Number(exam.total_marks);
            assessmentName = exam.exam_name;
        }

        /* ---------------------------------------------
           LOAD STUDENTS AND EXISTING MARKS
        --------------------------------------------- */

        const studentsResult = await client.query(
            `
            SELECT
                s.id,
                s.full_name,
                s.student_code,
                m.score AS mark
            FROM students s
            LEFT JOIN marks m
                ON m.student_id = s.id
               AND m.examination_id = $1
               AND m.class_id = s.class_id
            WHERE s.school_id = $2
              AND s.class_id = $3
            ORDER BY s.full_name
            `,
            [
                examinationId,
                assignment.school_id,
                assignment.class_id
            ]
        );

        return json({
            success: true,
            assessment: {
                type,
                id: assessmentId,
                examination_id: examinationId,
                name: assessmentName,
                total_marks: totalMarks
            },
            students: studentsResult.rows
        });

    } catch (error) {
        console.error("Load record marks students error:", error);

        return json({
            success: false,
            message: "Unable to load students."
        }, 500);

    } finally {
        if (client) {
            await client.end().catch(() => {});
        }
    }
}
