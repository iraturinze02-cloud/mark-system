
import {
    connectDB,
    authenticateRole,
    json
} from "../_utils.js";

/* =====================================================
   HELPERS
===================================================== */

function validId(value) {
    const number = Number(value);

    return Number.isSafeInteger(number) && number > 0
        ? number
        : null;
}

/* =====================================================
   GET: TEACHER RESULTS
===================================================== */

export async function onRequestGet(context) {

    const auth = await authenticateRole(context, [
        "teacher",
        "school_admin",
        "sector_admin"
    ]);

    if (auth.error) return auth.error;

    const url = new URL(context.request.url);

    const academicYearId = validId(
        url.searchParams.get("academic_year_id")
    );

    const termId = validId(
        url.searchParams.get("term_id")
    );

    if (!academicYearId || !termId) {
        return json({
            success: false,
            message: "Please select an academic year and term."
        }, 400);
    }

    let schoolId = null;
    let teacherId = null;
    let teacherName = null;
    let schoolName = null;

    let client;

    try {

        client = await connectDB(context);

        /* =================================================
           1. TEACHER ACCESS
        ================================================= */

        if (auth.role === "teacher") {

            if (!auth.schoolId) {
                return json({
                    success: false,
                    message: "Your account is not linked to a school."
                }, 403);
            }

            schoolId = validId(auth.schoolId);

            if (!schoolId) {
                return json({
                    success: false,
                    message: "Invalid school account information."
                }, 403);
            }

            const teacherResult = await client.query(
                `
                SELECT
                    t.id,
                    u.full_name,
                    s.school_name

                FROM teachers t

                INNER JOIN users u
                    ON u.id = t.user_id
                   AND u.school_id = t.school_id
                   AND u.role = 'teacher'

                INNER JOIN schools s
                    ON s.id = t.school_id

                WHERE t.user_id = $1
                  AND t.school_id = $2

                LIMIT 1
                `,
                [
                    auth.userId,
                    schoolId
                ]
            );

            if (teacherResult.rowCount === 0) {
                return json({
                    success: false,
                    message: "Your teacher profile could not be found."
                }, 404);
            }

            teacherId = String(teacherResult.rows[0].id);
            teacherName = teacherResult.rows[0].full_name;
            schoolName = teacherResult.rows[0].school_name;
        }

        /* =================================================
           2. SCHOOL ADMIN ACCESS
        ================================================= */

        else if (auth.role === "school_admin") {

            schoolId = validId(auth.schoolId);

            teacherId = validId(
                url.searchParams.get("teacher_id")
            );

            if (!schoolId) {
                return json({
                    success: false,
                    message: "Your account is not linked to a school."
                }, 403);
            }

            if (!teacherId) {
                return json({
                    success: false,
                    message: "Please select a valid teacher."
                }, 400);
            }

            const teacherResult = await client.query(
                `
                SELECT
                    t.id,
                    u.full_name,
                    s.school_name

                FROM teachers t

                INNER JOIN users u
                    ON u.id = t.user_id
                   AND u.school_id = t.school_id
                   AND u.role = 'teacher'

                INNER JOIN schools s
                    ON s.id = t.school_id

                WHERE t.id = $1
                  AND t.school_id = $2

                LIMIT 1
                `,
                [
                    teacherId,
                    schoolId
                ]
            );

            if (teacherResult.rowCount === 0) {
                return json({
                    success: false,
                    message: "This teacher does not belong to your school."
                }, 403);
            }

            teacherName = teacherResult.rows[0].full_name;
            schoolName = teacherResult.rows[0].school_name;
            teacherId = String(teacherResult.rows[0].id);
        }

        /* =================================================
           3. SECTOR ADMIN ACCESS
        ================================================= */

        else if (auth.role === "sector_admin") {

            schoolId = validId(
                url.searchParams.get("school_id")
            );

            teacherId = validId(
                url.searchParams.get("teacher_id")
            );

            if (!schoolId || !teacherId) {
                return json({
                    success: false,
                    message: "A valid school and teacher must be selected."
                }, 400);
            }

            if (!auth.sectorId) {
                return json({
                    success: false,
                    message: "Your account is not linked to a sector."
                }, 403);
            }

            const teacherResult = await client.query(
                `
                SELECT
                    t.id,
                    u.full_name,
                    s.school_name

                FROM teachers t

                INNER JOIN users u
                    ON u.id = t.user_id
                   AND u.school_id = t.school_id
                   AND u.role = 'teacher'

                INNER JOIN schools s
                    ON s.id = t.school_id

                WHERE t.id = $1
                  AND t.school_id = $2
                  AND s.sector_id = $3

                LIMIT 1
                `,
                [
                    teacherId,
                    schoolId,
                    auth.sectorId
                ]
            );

            if (teacherResult.rowCount === 0) {
                return json({
                    success: false,
                    message: "This teacher is not accessible within your sector."
                }, 403);
            }

            teacherName = teacherResult.rows[0].full_name;
            schoolName = teacherResult.rows[0].school_name;
            teacherId = String(teacherResult.rows[0].id);
        }

        /* =================================================
           4. VALIDATE ACADEMIC YEAR AND TERM

           The selected academic year and term must belong
           to the selected teacher's school.

           This prevents mixing IDs between schools.
        ================================================= */

        const periodResult = await client.query(
            `
            SELECT
                ay.id AS academic_year_id,
                ay.year_name,

                tr.id AS term_id,
                tr.term_name,
                tr.term_number

            FROM academic_years ay

            INNER JOIN terms tr
                ON tr.school_id = ay.school_id
               AND tr.academic_year_id = ay.id

            WHERE ay.school_id = $1
              AND ay.id = $2
              AND tr.id = $3

            LIMIT 1
            `,
            [
                schoolId,
                academicYearId,
                termId
            ]
        );

        if (periodResult.rowCount === 0) {
            return json({
                success: false,
                message: "The selected academic year or term does not belong to this school."
            }, 400);
        }

        const academicPeriod = periodResult.rows[0];

        /* =================================================
           5. LOAD ASSIGNMENTS, TESTS, STUDENTS AND MARKS

           IMPORTANT:

           - Assignments are not filtered by academic period.
           - Tests are filtered through test_schools.
           - Students are filtered through student_enrollments.
           - Only active enrolled students are included.
           - Students without marks remain in the results.
           - Gender is returned for gender analysis.
        ================================================= */

        const result = await client.query(
            `
            SELECT
                ta.id AS assignment_id,

                ta.school_id,
                sch.school_name,

                ta.teacher_id,

                c.id AS class_id,
                c.class_name,

                CASE c.level_id
                    WHEN 1 THEN 'Primary'
                    WHEN 2 THEN 'Lower Secondary'
                    WHEN 3 THEN 'Upper Secondary'
                    ELSE 'Unknown'
                END AS class_level,

                sub.id AS subject_id,
                sub.subject_name,

                tst.id AS test_id,
                tst.test_name,
                tst.status AS test_status,
                tst.created_at AS test_created_at,

                ts.total_marks AS maximum_mark,

                st.id AS student_id,
                st.full_name AS student_name,
                st.student_code,
                st.gender,

                m.score

            FROM teacher_assignments ta

            INNER JOIN teachers t
                ON t.id = ta.teacher_id
               AND t.school_id = ta.school_id

            INNER JOIN users u
                ON u.id = t.user_id
               AND u.school_id = t.school_id
               AND u.role = 'teacher'

            INNER JOIN schools sch
                ON sch.id = ta.school_id

            INNER JOIN classes c
                ON c.id = ta.class_id

            INNER JOIN school_levels sl
                ON sl.school_id = ta.school_id
               AND sl.level_id = c.level_id

            INNER JOIN subjects sub
                ON sub.id = ta.subject_id

            /* -----------------------------------------
               TEST CLASSES
            ----------------------------------------- */

            LEFT JOIN test_classes tc
                ON tc.school_id = ta.school_id
               AND tc.class_id = ta.class_id

            /* -----------------------------------------
               SCHOOL-SPECIFIC TEST ACADEMIC PERIOD
            ----------------------------------------- */

            LEFT JOIN test_schools tsc
                ON tsc.test_id = tc.test_id
               AND tsc.school_id = ta.school_id
               AND tsc.academic_year_id = $3
               AND tsc.term_id = $4

            /* -----------------------------------------
               TEST DETAILS
            ----------------------------------------- */

            LEFT JOIN tests tst
                ON tst.id = tc.test_id
               AND tsc.test_id IS NOT NULL
               AND EXISTS (
                    SELECT 1
                    FROM test_subjects check_subject
                    WHERE check_subject.test_id = tst.id
                      AND check_subject.subject_id = ta.subject_id
               )

            /* -----------------------------------------
               SUBJECT MAXIMUM MARK
            ----------------------------------------- */

            LEFT JOIN test_subjects ts
                ON ts.test_id = tst.id
               AND ts.subject_id = ta.subject_id

            /* -----------------------------------------
               STUDENT ENROLLMENT

               Get students enrolled in the selected
               school, class, academic year and term.
            ----------------------------------------- */

            LEFT JOIN LATERAL (
                SELECT DISTINCT ON (se.student_id)
                    se.student_id

                FROM student_enrollments se

                WHERE se.school_id = ta.school_id
                  AND se.class_id = ta.class_id
                  AND se.academic_year_id = $3
                  AND se.term_id = $4
                  AND LOWER(TRIM(se.status)) = 'active'

                ORDER BY
                    se.student_id,
                    se.created_at DESC,
                    se.id DESC

            ) enrollment ON TRUE

            /* -----------------------------------------
               STUDENT DETAILS
            ----------------------------------------- */

            LEFT JOIN students st
                ON st.id = enrollment.student_id
               AND st.school_id = ta.school_id
               AND st.class_id = ta.class_id
               AND st.status = 'active'

            /* -----------------------------------------
               MARKS

               A missing mark remains NULL.
               It must not be counted as a failure.
            ----------------------------------------- */

            LEFT JOIN marks m
                ON m.test_id = tst.id
               AND m.student_id = st.id
               AND m.class_id = ta.class_id
               AND m.subject_id = ta.subject_id

            /* -----------------------------------------
               SELECTED TEACHER
            ----------------------------------------- */

            WHERE ta.teacher_id = $1
              AND ta.school_id = $2

            ORDER BY
                c.class_name,
                sub.subject_name,
                tst.created_at DESC,
                st.full_name
            `,
            [
                teacherId,
                schoolId,
                academicYearId,
                termId
            ]
        );

        /* =================================================
           6. ORGANIZE RESULTS

           Structure:

           assignments[]
              tests[]
                 students[]
        ================================================= */

        const assignmentsMap = new Map();

        for (const row of result.rows) {

            const assignmentKey = String(row.assignment_id);

            /* -----------------------------------------
               CREATE ASSIGNMENT
            ----------------------------------------- */

            if (!assignmentsMap.has(assignmentKey)) {

                assignmentsMap.set(assignmentKey, {
                    assignment_id: assignmentKey,

                    school_id: String(row.school_id),
                    school_name: row.school_name,

                    teacher_id: String(row.teacher_id),

                    class_id: String(row.class_id),
                    class_name: row.class_name,
                    class_level: row.class_level,

                    subject_id: String(row.subject_id),
                    subject_name: row.subject_name,

                    tests: []
                });
            }

            const assignment =
                assignmentsMap.get(assignmentKey);

            /* -----------------------------------------
               NO TEST FOR THIS ASSIGNMENT
            ----------------------------------------- */

            if (row.test_id === null) {
                continue;
            }

            const testId = String(row.test_id);

            /* -----------------------------------------
               FIND OR CREATE TEST
            ----------------------------------------- */

            let test = assignment.tests.find(
                item => item.id === testId
            );

            if (!test) {

                test = {
                    id: testId,

                    name: row.test_name,
                    status: row.test_status,
                    created_at: row.test_created_at,

                    maximum_mark: row.maximum_mark === null
                        ? 0
                        : Number(row.maximum_mark),

                    students: []
                };

                assignment.tests.push(test);
            }

            /* -----------------------------------------
               NO STUDENT FOR THIS TEST
            ----------------------------------------- */

            if (row.student_id === null) {
                continue;
            }

            /* -----------------------------------------
               ADD STUDENT

               Gender is required by the frontend
               gender performance analysis.
            ----------------------------------------- */

            test.students.push({
                id: String(row.student_id),

                name: row.student_name,

                student_code: row.student_code,

                gender: row.gender,

                mark: row.score === null
                    ? null
                    : Number(row.score)
            });
        }

        /* =================================================
           7. SUCCESS RESPONSE
        ================================================= */

        return json({

            success: true,

            academic_period: {
                academic_year_id: String(
                    academicPeriod.academic_year_id
                ),

                academic_year: academicPeriod.year_name,

                term_id: String(
                    academicPeriod.term_id
                ),

                term: academicPeriod.term_name,

                term_number: Number(
                    academicPeriod.term_number
                )
            },

            teacher: {
                id: String(teacherId),

                full_name: teacherName,

                school_id: String(schoolId),

                school_name: schoolName
            },

            assignments: Array.from(
                assignmentsMap.values()
            )

        });

    } catch (error) {

        console.error("Teacher Results API error:", {
            message: error?.message,
            code: error?.code,
            detail: error?.detail,
            table: error?.table,
            constraint: error?.constraint
        });

        return json({
            success: false,
            message: "Unable to load teacher results."
        }, 500);

    } finally {

        if (client) {
            await client.end().catch(() => {});
        }

    }
}
