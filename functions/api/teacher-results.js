
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

    let schoolId = null;
    let teacherId = null;
    let teacherName = null;
    let schoolName = null;

    let client;

    try {
        client = await connectDB(context);

        /* ---------------------------------------------
           1. TEACHER
           Automatically identify the logged-in teacher.
        --------------------------------------------- */

        if (auth.role === "teacher") {

            if (!auth.schoolId) {
                return json({
                    success: false,
                    message: "Your account is not linked to a school."
                }, 403);
            }

            schoolId = auth.schoolId;

            const teacherResult = await client.query(
                `SELECT
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
                 LIMIT 1`,
                [auth.userId, schoolId]
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

        /* ---------------------------------------------
           2. SCHOOL ADMIN
           Only teachers belonging to their own school.
        --------------------------------------------- */

        else if (auth.role === "school_admin") {

            schoolId = auth.schoolId;
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
                `SELECT
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
                 LIMIT 1`,
                [teacherId, schoolId]
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

        /* ---------------------------------------------
           3. SECTOR ADMIN
           Only teachers in schools belonging to their sector.
        --------------------------------------------- */

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

            const teacherResult = await client.query(
                `SELECT
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
                 LIMIT 1`,
                [teacherId, schoolId, auth.sectorId]
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

        /* ---------------------------------------------
           LOAD ASSIGNMENTS, TESTS, STUDENTS AND MARKS
        --------------------------------------------- */

        const result = await client.query(
            `SELECT
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

             LEFT JOIN test_classes tc
                ON tc.school_id = ta.school_id
               AND tc.class_id = ta.class_id

             LEFT JOIN tests tst
                ON tst.id = tc.test_id
               AND EXISTS (
                    SELECT 1
                    FROM test_subjects check_subject
                    WHERE check_subject.test_id = tst.id
                      AND check_subject.subject_id = ta.subject_id
               )

             LEFT JOIN test_subjects ts
                ON ts.test_id = tst.id
               AND ts.subject_id = ta.subject_id

             LEFT JOIN students st
                ON st.class_id = ta.class_id
               AND st.school_id = ta.school_id
               AND st.status = 'active'

             LEFT JOIN marks m
                ON m.test_id = tst.id
               AND m.student_id = st.id
               AND m.class_id = ta.class_id
               AND m.subject_id = ta.subject_id

             WHERE ta.teacher_id = $1
               AND ta.school_id = $2

             ORDER BY
                c.class_name,
                sub.subject_name,
                tst.created_at DESC,
                st.full_name`,
            [teacherId, schoolId]
        );

        /* ---------------------------------------------
           ORGANIZE RESULTS
        --------------------------------------------- */

        const assignmentsMap = new Map();

        for (const row of result.rows) {

            const assignmentKey = String(row.assignment_id);

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

            if (row.test_id === null) continue;

            const testId = String(row.test_id);

            let test = assignment.tests.find(
                item => item.id === testId
            );

            if (!test) {

                test = {
                    id: testId,
                    name: row.test_name,
                    status: row.test_status,
                    created_at: row.test_created_at,
                    maximum_mark: Number(row.maximum_mark),
                    students: []
                };

                assignment.tests.push(test);
            }

            if (row.student_id === null) continue;

            test.students.push({
                id: String(row.student_id),
                name: row.student_name,
                student_code: row.student_code,
                mark: row.score === null
                    ? null
                    : Number(row.score)
            });
        }

        /* ---------------------------------------------
           SUCCESS RESPONSE
        --------------------------------------------- */

        return json({
            success: true,

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
            table: error?.table
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
