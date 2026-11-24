
import {
    connectDB,
    authenticateRole,
    json
} from "../_utils.js";

/* =====================================================
   GET: SCHOOL MARKS — VIEW ONLY

   ACCESS:

   1. SECTOR ADMIN:
      - Views results across their sector.

   2. SCHOOL ADMIN / DOS:
      - Without test_id:
        Views their own school's results.

      - With test_id:
        Can view sector-wide results only when:
        a. The test was created by a Sector Admin.
        b. The test is closed.
        c. The test belongs to their sector.

   ACADEMIC PERIOD:
      - Uses the selected academic year and term.
      - Gets period-specific IDs from test_schools.
      - Matches each school's own academic year and term IDs.

   STUDENT RETRIEVAL:
      - Uses student_enrollments.
      - Matches the test's school, class, academic year
        and term.
      - Uses the enrollment's historical class/status.
===================================================== */

export async function onRequestGet(context) {

    const auth = await authenticateRole(context, [
        "sector_admin",
        "school_admin",
        "dos"
    ]);

    if (auth.error) return auth.error;

    let client;

    try {

        client = await connectDB(context);

        let scopeCondition = "";
        let parameters = [];

        const url = new URL(context.request.url);

        /* =================================================
           SELECTED ACADEMIC YEAR AND TERM
        ================================================= */

        const selectedYear = url.searchParams
            .get("academic_year");

        const selectedTerm = Number(
            url.searchParams.get("term_number")
        );

        if (
            !selectedYear ||
            !Number.isInteger(selectedTerm) ||
            selectedTerm < 1 ||
            selectedTerm > 3
        ) {

            return json({
                success: false,
                message: "Please select a valid academic year and term."
            }, 400);

        }

        const requestedTestId = url.searchParams.get("test_id");

        const accessDeniedMessage =
            "You are not yet allowed to access this page because marks recording for this test is still in progress. Please come back later.";

        /* =================================================
           SECTOR ADMIN
        ================================================= */

        if (auth.role === "sector_admin") {

            if (!auth.sectorId) {

                return json({
                    success: false,
                    message: "Your account is not linked to a sector."
                }, 403);

            }

            scopeCondition = `
                EXISTS (
                    SELECT 1
                    FROM schools scope_school
                    WHERE scope_school.id = tc.school_id
                      AND scope_school.sector_id = $1
                )
                AND (
                    t.sector_id = $1
                    OR EXISTS (
                        SELECT 1
                        FROM test_schools assigned_school
                        INNER JOIN schools assigned
                            ON assigned.id = assigned_school.school_id
                        WHERE assigned_school.test_id = t.id
                          AND assigned.sector_id = $1
                    )
                )
            `;

            parameters = [auth.sectorId];

        }

        /* =================================================
           SCHOOL ADMIN / DOS
        ================================================= */

        else {

            if (!auth.schoolId) {

                return json({
                    success: false,
                    message: "Your account is not linked to a school."
                }, 403);

            }

            /* ---------------------------------------------
               CASE 1: NORMAL SCHOOL MARKS DASHBOARD
            --------------------------------------------- */

            if (!requestedTestId) {

                scopeCondition = `
                    tc.school_id = $1
                    AND (
                        t.school_id = $1
                        OR EXISTS (
                            SELECT 1
                            FROM test_schools assigned_school
                            WHERE assigned_school.test_id = t.id
                              AND assigned_school.school_id = $1
                        )
                    )
                `;

                parameters = [auth.schoolId];

            }

            /* ---------------------------------------------
               CASE 2: SECTOR-WIDE RESULTS
            --------------------------------------------- */

            else {

                const accessCheck = await client.query(
                    `
                    SELECT t.id

                    FROM tests t

                    INNER JOIN users creator
                        ON creator.id = t.created_by

                    INNER JOIN schools user_school
                        ON user_school.id = $2

                    WHERE t.id = $1
                      AND t.status = 'closed'
                      AND creator.role = 'sector_admin'
                      AND t.sector_id = user_school.sector_id

                    LIMIT 1
                    `,
                    [requestedTestId, auth.schoolId]
                );

                if (!accessCheck.rows.length) {

                    return json({
                        success: false,
                        message: accessDeniedMessage
                    }, 403);

                }

                scopeCondition = `
                    t.id = $1
                    AND t.status = 'closed'
                    AND creator.role = 'sector_admin'

                    AND t.sector_id = (
                        SELECT sector_id
                        FROM schools
                        WHERE id = $2
                    )

                    AND tc.school_id IN (
                        SELECT id
                        FROM schools
                        WHERE sector_id = (
                            SELECT sector_id
                            FROM schools
                            WHERE id = $2
                        )
                    )
                `;

                parameters = [
                    requestedTestId,
                    auth.schoolId
                ];

            }

        }

        /* =================================================
           ADD SELECTED ACADEMIC PERIOD PARAMETERS

           Existing role parameters remain unchanged.
           These two parameters are appended safely.
        ================================================= */

        parameters.push(selectedYear);

        const yearParameter = `$${parameters.length}`;

        parameters.push(selectedTerm);

        const termParameter = `$${parameters.length}`;

        scopeCondition += `
            AND ay.year_name = ${yearParameter}
            AND tm.term_number = ${termParameter}
        `;

        /* =================================================
           LOAD TESTS, SCHOOLS, CLASSES, ENROLLMENTS,
           STUDENTS, SUBJECTS AND MARKS
        ================================================= */

        const result = await client.query(
            `
            SELECT

                /* TEST */

                t.id AS test_id,
                t.test_name,
                t.status,
                t.created_at AS test_created_at,
                t.created_by,
                t.sector_id AS test_sector_id,
                t.school_id AS test_school_id,

                creator.full_name AS creator_name,
                creator.role AS creator_role,

                /* TEST SCHOOL AND ACADEMIC PERIOD */

                tc.school_id,
                tsc.academic_year_id,
                tsc.term_id,

                sch.school_name,

                /* CLASS */

                c.id AS class_id,
                c.class_name,

                CASE c.level_id
                    WHEN 1 THEN 'Primary'
                    WHEN 2 THEN 'Lower Secondary'
                    WHEN 3 THEN 'Upper Secondary'
                    ELSE 'Unknown'
                END AS class_level,

                /* ENROLLED STUDENT */

                st.id AS student_id,
                st.full_name AS student_name,
                st.student_code,

                se.status AS enrollment_status,

                /* SUBJECT */

                sub.id AS subject_id,
                sub.subject_name,
                sub.subject_code,

                testSubject.total_marks AS maximum_mark,

                /* RECORDED MARK */

                m.score

            FROM tests t

            INNER JOIN users creator
                ON creator.id = t.created_by

            INNER JOIN test_classes tc
                ON tc.test_id = t.id

            /* Each test class must belong to a test school
               with its own academic year and term. */

            INNER JOIN test_schools tsc
                ON tsc.test_id = t.id
               AND tsc.school_id = tc.school_id

            /* Match the school's academic year. */

            INNER JOIN academic_years ay
                ON ay.id = tsc.academic_year_id
               AND ay.school_id = tsc.school_id

            /* Match the school's term. */

            INNER JOIN terms tm
                ON tm.id = tsc.term_id
               AND tm.academic_year_id = tsc.academic_year_id
               AND tm.school_id = tsc.school_id

            INNER JOIN classes c
                ON c.id = tc.class_id

            INNER JOIN school_levels sl
                ON sl.school_id = tc.school_id
               AND sl.level_id = c.level_id

            INNER JOIN schools sch
                ON sch.id = tc.school_id

            /* =================================================
               HISTORICAL STUDENT ENROLLMENT

               Do not use st.class_id or st.status here.

               The enrollment determines the student's class
               and status for the test's academic period.
            ================================================= */

            LEFT JOIN student_enrollments se
                ON se.school_id = tc.school_id
               AND se.class_id = c.id
               AND se.academic_year_id = tsc.academic_year_id
               AND se.term_id = tsc.term_id
               AND LOWER(TRIM(se.status)) = 'active'

            LEFT JOIN students st
                ON st.id = se.student_id
               AND st.school_id = tc.school_id

            INNER JOIN test_subjects testSubject
                ON testSubject.test_id = t.id

            INNER JOIN subjects sub
                ON sub.id = testSubject.subject_id

            LEFT JOIN marks m
                ON m.test_id = t.id
               AND m.student_id = st.id
               AND m.class_id = c.id
               AND m.subject_id = sub.id

            WHERE ${scopeCondition}

            ORDER BY
                t.created_at DESC,
                sch.school_name,
                c.class_name,
                st.full_name,
                sub.subject_name
            `,
            parameters
        );

        /* =================================================
           ORGANIZE RESULTS
        ================================================= */

        const testsMap = new Map();

        for (const row of result.rows) {

            const testKey = String(row.test_id);

            if (!testsMap.has(testKey)) {

                testsMap.set(testKey, {

                    id: testKey,

                    name: row.test_name,

                    status: row.status,

                    created_at: row.test_created_at,

                    created_by: String(row.created_by),

                    creator_name: row.creator_name,

                    creator_role: row.creator_role,

                    sector_id: row.test_sector_id === null
                        ? null
                        : String(row.test_sector_id),

                    school_id: row.test_school_id === null
                        ? null
                        : String(row.test_school_id),

                    report_card_type:
                        row.creator_role === "sector_admin"
                            ? "school_and_sector"
                            : "school_only",

                    classes: []

                });

            }

            const test = testsMap.get(testKey);

            /* ---------------------------------------------
               FIND OR CREATE CLASS
            --------------------------------------------- */

            let classItem = test.classes.find(
                item =>
                    String(item.class_id) === String(row.class_id) &&
                    String(item.school_id) === String(row.school_id)
            );

            if (!classItem) {

                classItem = {

                    class_id: String(row.class_id),

                    class_name: row.class_name,

                    class_level: row.class_level,

                    school_id: String(row.school_id),

                    school_name: row.school_name,

                    academic_year_id: String(row.academic_year_id),

                    term_id: String(row.term_id),

                    subjects: [],

                    students: []

                };

                test.classes.push(classItem);

            }

            /* ---------------------------------------------
               ADD SUBJECT
            --------------------------------------------- */

            const subjectId = String(row.subject_id);

            if (
                !classItem.subjects.some(
                    subject => subject.id === subjectId
                )
            ) {

                classItem.subjects.push({

                    id: subjectId,

                    name: row.subject_name,

                    code: row.subject_code,

                    maximum_mark: Number(row.maximum_mark)

                });

            }

            /* ---------------------------------------------
               ADD STUDENT
            --------------------------------------------- */

            if (row.student_id === null) continue;

            const studentId = String(row.student_id);

            let student = classItem.students.find(
                item => item.id === studentId
            );

            if (!student) {

                student = {

                    id: studentId,

                    name: row.student_name,

                    student_code: row.student_code,

                    marks: {}

                };

                classItem.students.push(student);

            }

            student.marks[subjectId] =
                row.score === null
                    ? null
                    : Number(row.score);

        }

        /* =================================================
           RESPONSE

           Existing response structure preserved.
        ================================================= */

        return json({

            success: true,

            tests: Array.from(testsMap.values()),

            user: {

                role: auth.role,

                schoolId: auth.schoolId,

                sectorId: auth.sectorId

            }

        });

    } catch (error) {

        console.error(
            "School Marks loading error:",
            error
        );

        return json({

            success: false,

            message: "Unable to load school marks."

        }, 500);

    } finally {

        if (client) {

            await client.end().catch(() => {});

        }

    }

}
