
import {
    connectDB,
    requireTestUser,
    json
} from "../../_utils.js";

/* =====================================================
   GET: ACTIVE ENROLLED STUDENTS FOR A SELECTED TEST

   FILTERED BY:
   - Academic year
   - Term
   - Class
   - Teacher assignment

   RETURNS:
   - Student information
   - Subclass ID
   - Subclass name
   - Existing marks
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

    const academicYearId = Number(
        url.searchParams.get("academic_year_id")
    );

    const termId = Number(
        url.searchParams.get("term_id")
    );

    if (
        !Number.isSafeInteger(testId) || testId <= 0 ||
        !Number.isSafeInteger(assignmentId) || assignmentId <= 0 ||
        !Number.isSafeInteger(academicYearId) || academicYearId <= 0 ||
        !Number.isSafeInteger(termId) || termId <= 0
    ) {
        return json({
            success: false,
            message: "A valid Test, assignment and academic period are required."
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
                t.id AS term_id,
                t.term_name AS term,
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
            return json({
                success: false,
                message: "The selected academic year or term is invalid for your school."
            }, 400);
        }

        const period = periodResult.rows[0];

        /* ---------------------------------------------
           2. VERIFY TEACHER ASSIGNMENT
        --------------------------------------------- */

        const assignmentResult = await client.query(
            `
            SELECT
                ta.id AS assignment_id,
                ta.school_id,
                ta.class_id,
                ta.subject_id,
                c.class_name,

                CASE c.level_id
                    WHEN 1 THEN 'Primary'
                    WHEN 2 THEN 'Lower Secondary'
                    WHEN 3 THEN 'Upper Secondary'
                    ELSE 'Unknown'
                END AS class_level,

                sub.subject_name

            FROM teacher_assignments ta

            INNER JOIN teachers tr
                ON tr.id = ta.teacher_id
               AND tr.school_id = ta.school_id

            INNER JOIN users u
                ON u.id = tr.user_id
               AND u.school_id = tr.school_id
               AND u.role = 'teacher'

            INNER JOIN classes c
                ON c.id = ta.class_id

            INNER JOIN school_levels sl
                ON sl.school_id = ta.school_id
               AND sl.level_id = c.level_id

            INNER JOIN subjects sub
                ON sub.id = ta.subject_id

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
            return json({
                success: false,
                message: "This class and subject are not assigned to you."
            }, 403);
        }

        const assignment = assignmentResult.rows[0];

        /* ---------------------------------------------
           3. VERIFY TEST, SCHOOL, PERIOD, CLASS
              AND SUBJECT
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
                assignment.subject_id,
                academicYearId,
                termId
            ]
        );

        if (testResult.rowCount === 0) {
            return json({
                success: false,
                message: "This Test does not belong to the selected school, academic period, class and subject."
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
            return json({
                success: false,
                message: "The maximum mark for this Test subject has not been configured. Please contact the Test administrator."
            }, 400);
        }

        /* ---------------------------------------------
           5. AUTOMATIC CLOSING TIME CHECK
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

        /* ---------------------------------------------
           6. VERIFY TEST IS OPEN
        --------------------------------------------- */

        if (test.status !== "open") {
            return json({
                success: false,
                message: "Marks cannot be recorded because this Test is not open.",
                test
            }, 403);
        }

        /* ---------------------------------------------
           7. LOAD ACTIVE ENROLLMENTS, SUBCLASSES
              AND EXISTING MARKS

           SUBCLASS RELATIONSHIP:

           student_enrollments.subclass_id
                    |
                    v
           school_class_subclasses.id

           The LEFT JOIN keeps students who have not
           yet been allocated to a subclass.
        --------------------------------------------- */

        const studentsResult = await client.query(
            `
            SELECT DISTINCT ON (s.id)

                s.id AS student_id,
                s.student_code,
                s.full_name,
                s.gender,

                se.id AS enrollment_id,
                se.class_id AS enrollment_class_id,

                se.subclass_id,

                scs.subclass_name,

                m.id AS mark_id,
                m.score AS mark,
                m.remarks

            FROM student_enrollments se

            INNER JOIN students s
                ON s.id = se.student_id
               AND s.school_id = se.school_id
               AND s.class_id = se.class_id
               AND s.status = 'active'

            LEFT JOIN school_class_subclasses scs
                ON scs.id = se.subclass_id
               AND scs.school_id = se.school_id
               AND scs.academic_year_id = se.academic_year_id
               AND scs.class_id = se.class_id

            LEFT JOIN marks m
                ON m.test_id = $1
               AND m.student_id = s.id
               AND m.class_id = se.class_id
               AND m.subject_id = $4

            WHERE se.school_id = $2
              AND se.class_id = $3
              AND se.academic_year_id = $5
              AND se.term_id = $6
              AND LOWER(TRIM(se.status)) = 'active'

            ORDER BY
                s.id,
                se.created_at DESC,
                se.id DESC
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

        /* ---------------------------------------------
           8. RETURN DATA
        --------------------------------------------- */

        return json({
            success: true,

            academic_period: period,

            test: {
                ...test,
                total_marks: Number(test.total_marks)
            },

            assignment,

            students: studentsResult.rows.map(student => ({
                ...student,

                student_id: String(student.student_id),
                enrollment_id: String(student.enrollment_id),
                enrollment_class_id: String(student.enrollment_class_id),

                subclass_id: student.subclass_id === null
                    ? null
                    : String(student.subclass_id),

                subclass_name: student.subclass_name || null,

                mark_id: student.mark_id === null
                    ? null
                    : String(student.mark_id),

                mark: student.mark === null
                    ? null
                    : Number(student.mark)
            }))
        });

    } catch (error) {
        console.error(
            "Record Marks students error:",
            error
        );

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
