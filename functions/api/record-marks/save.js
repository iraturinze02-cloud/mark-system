
import {
    connectDB,
    requireTestUser,
    json
} from "../../_utils.js";

/* =====================================================
   POST: SAVE TEST MARKS
   VALIDATE SELECTED ACADEMIC YEAR AND TERM
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
    const academicYearId = Number(body.academic_year_id);
    const termId = Number(body.term_id);
    const submittedMarks = body.marks;

    if (
        !Number.isSafeInteger(testId) || testId <= 0 ||
        !Number.isSafeInteger(assignmentId) || assignmentId <= 0 ||
        !Number.isSafeInteger(academicYearId) || academicYearId <= 0 ||
        !Number.isSafeInteger(termId) || termId <= 0 ||
        !Array.isArray(submittedMarks) ||
        submittedMarks.length === 0 ||
        submittedMarks.length > 1000
    ) {
        return json({
            success: false,
            message: "Please provide a valid Test, assignment, academic period and marks."
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

        if (!Number.isSafeInteger(studentId) || studentId <= 0) {
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

        // Empty scores are skipped.
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

        // Remarks are deliberately not accepted or updated here.
        marks.push({
            studentId,
            score
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
           1. VERIFY SELECTED ACADEMIC PERIOD
        --------------------------------------------- */

        const periodResult = await client.query(
            `
            SELECT
                ay.id AS academic_year_id,
                ay.year_name,
                t.id AS term_id,
                t.term_name,
                t.term_number
            FROM academic_years ay
            INNER JOIN terms t
                ON t.academic_year_id = ay.id
               AND t.school_id = ay.school_id
            WHERE ay.id = $1
              AND t.id = $2
              AND ay.school_id = $3
              AND t.school_id = $3
            LIMIT 1
            `,
            [
                academicYearId,
                termId,
                auth.schoolId
            ]
        );

        if (periodResult.rowCount === 0) {
            await client.query("ROLLBACK");
            transactionStarted = false;

            return json({
                success: false,
                message: "The selected academic year or term is invalid for your school."
            }, 400);
        }

        /* ---------------------------------------------
           2. VERIFY TEACHER ASSIGNMENT
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

            INNER JOIN users u
                ON u.id = tr.user_id
               AND u.school_id = tr.school_id
               AND u.role = 'teacher'

            WHERE ta.id = $1
              AND tr.user_id = $2
              AND tr.school_id = $3

            LIMIT 1
            `,
            [
                assignmentId,
                auth.userId,
                auth.schoolId
            ]
        );

        if (assignmentResult.rowCount === 0) {
            await client.query("ROLLBACK");
            transactionStarted = false;

            return json({
                success: false,
                message: "This class and subject are not assigned to you."
            }, 403);
        }

        const assignment = assignmentResult.rows[0];

        /* ---------------------------------------------
           3. LOCK AND VERIFY TEST
              SCHOOL + PERIOD + CLASS + SUBJECT
        --------------------------------------------- */

        const testResult = await client.query(
            `
            SELECT
                t.id,
                t.test_name,
                t.status,
                t.closing_at,
                ts.total_marks

            FROM tests t

            INNER JOIN test_schools test_school
                ON test_school.test_id = t.id
               AND test_school.school_id = $2
               AND test_school.academic_year_id = $5
               AND test_school.term_id = $6

            INNER JOIN test_classes tc
                ON tc.test_id = t.id
               AND tc.school_id = test_school.school_id
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
                assignment.subject_id,
                academicYearId,
                termId
            ]
        );

        if (testResult.rowCount === 0) {
            await client.query("ROLLBACK");
            transactionStarted = false;

            return json({
                success: false,
                message: "This Test does not match the selected school, academic period, class and subject."
            }, 403);
        }

        const test = testResult.rows[0];

        /* ---------------------------------------------
           4. VERIFY MAXIMUM MARK
        --------------------------------------------- */

        if (
            test.total_marks === null ||
            test.total_marks === undefined ||
            !Number.isFinite(Number(test.total_marks)) ||
            Number(test.total_marks) <= 0
        ) {
            await client.query("ROLLBACK");
            transactionStarted = false;

            return json({
                success: false,
                message: "The maximum mark for this Test subject has not been configured."
            }, 400);
        }

        const maximumMark = Number(test.total_marks);

        /* ---------------------------------------------
           5. VERIFY TEST STATUS
        --------------------------------------------- */

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
           6. VALIDATE MARKS AGAINST MAXIMUM
        --------------------------------------------- */

        for (const item of marks) {
            if (item.score > maximumMark) {
                await client.query("ROLLBACK");
                transactionStarted = false;

                return json({
                    success: false,
                    message: `A mark cannot exceed ${maximumMark}.`,
                    maximum_mark: maximumMark,
                    student_id: item.studentId
                }, 400);
            }
        }

        /* ---------------------------------------------
           7. VERIFY ACTIVE STUDENT ENROLLMENTS

           Enrollment determines the student's class
           in the selected academic year and term.

           Lock matching enrollment rows while saving.
        --------------------------------------------- */

        const studentIds = marks.map(item => item.studentId);

        const studentsResult = await client.query(
            `
            SELECT
                se.student_id
            FROM student_enrollments se

            INNER JOIN students s
                ON s.id = se.student_id
               AND s.school_id = se.school_id

            WHERE se.school_id = $1
              AND se.class_id = $2
              AND se.academic_year_id = $3
              AND se.term_id = $4
              AND LOWER(TRIM(se.status)) = 'active'
              AND se.student_id = ANY($5::bigint[])

            FOR UPDATE OF se
            `,
            [
                assignment.school_id,
                assignment.class_id,
                academicYearId,
                termId,
                studentIds
            ]
        );

        const enrolledStudentIds = new Set(
    studentsResult.rows.map(row => String(row.student_id))
);

if (enrolledStudentIds.size !== studentIds.length) {
    await client.query("ROLLBACK");
    transactionStarted = false;

    return json({
        success: false,
        message: "One or more students are not actively enrolled in this class for the selected academic year and term. Refresh the student list and try again."
    }, 400);
}

        /* ---------------------------------------------
           8. SAVE OR UPDATE TEST MARKS
              DO NOT OVERWRITE REMARKS
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
                    recorded_by = EXCLUDED.recorded_by,
                    updated_at = NOW()
                `,
                [
                    testId,
                    item.studentId,
                    assignment.class_id,
                    assignment.subject_id,
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
            message: "Test marks saved successfully.",
            saved_count: savedCount,
            test_id: testId,
            academic_year_id: academicYearId,
            term_id: termId,
            maximum_mark: maximumMark
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
