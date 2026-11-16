
import {
    connectDB,
    authenticateRole,
    json
} from "../_utils.js";

/* =====================================================
   GET: SCHOOL MARKS — VIEW ONLY
   Includes test creator information for report cards.
===================================================== */

export async function onRequestGet(context) {
    const auth = await authenticateRole(context, [
        "sector_admin",
        "school_admin"
    ]);

    if (auth.error) return auth.error;

    let client;

    try {
        client = await connectDB(context);

        let scopeCondition = "";
        let parameters = [];

        /* ---------------------------------------------
           SECTOR ADMIN
           All schools and classes in their sector.
        --------------------------------------------- */

        if (auth.role === "sector_admin") {
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

        } else {

            /* -----------------------------------------
               SCHOOL ADMIN
               Only their own school's classes and tests.
            ----------------------------------------- */

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
           LOAD TESTS, CREATORS, CLASSES, STUDENTS,
           SUBJECTS AND MARKS
        --------------------------------------------- */

        const result = await client.query(
            `
            SELECT
                t.id AS test_id,
                t.test_name,
                t.status,
                t.created_at AS test_created_at,
                t.created_by,
                t.sector_id AS test_sector_id,
                t.school_id AS test_school_id,

                creator.full_name AS creator_name,
                creator.role AS creator_role,

                tc.school_id,

                sch.school_name,

                c.id AS class_id,
                c.class_name,

                CASE c.level_id
                    WHEN 1 THEN 'Primary'
                    WHEN 2 THEN 'Lower Secondary'
                    WHEN 3 THEN 'Upper Secondary'
                    ELSE 'Unknown'
                END AS class_level,

                st.id AS student_id,
                st.full_name AS student_name,
                st.student_code,

                sub.id AS subject_id,
                sub.subject_name,
                sub.subject_code,

                ts.total_marks AS maximum_mark,

                m.score

            FROM tests t

            INNER JOIN users creator
                ON creator.id = t.created_by

            INNER JOIN test_classes tc
                ON tc.test_id = t.id

            INNER JOIN classes c
                ON c.id = tc.class_id

            INNER JOIN school_levels sl
                ON sl.school_id = tc.school_id
               AND sl.level_id = c.level_id

            INNER JOIN schools sch
                ON sch.id = tc.school_id

            LEFT JOIN students st
                ON st.class_id = c.id
               AND st.school_id = tc.school_id
               AND st.status = 'active'

            INNER JOIN test_subjects ts
                ON ts.test_id = t.id

            INNER JOIN subjects sub
                ON sub.id = ts.subject_id

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

        /* ---------------------------------------------
           ORGANIZE RESULTS
        --------------------------------------------- */

        const testsMap = new Map();

        for (const row of result.rows) {

            const testKey = String(row.test_id);

            if (!testsMap.has(testKey)) {

                testsMap.set(testKey, {
                    id: testKey,
                    name: row.test_name,
                    status: row.status,
                    created_at: row.test_created_at,

                    // Test creator information
                    created_by: String(row.created_by),
                    creator_name: row.creator_name,
                    creator_role: row.creator_role,

                    // Original test ownership
                    sector_id: row.test_sector_id === null
                        ? null
                        : String(row.test_sector_id),

                    school_id: row.test_school_id === null
                        ? null
                        : String(row.test_school_id),

                    // Used by the frontend to choose report-card sections
                    report_card_type: row.creator_role === "sector_admin"
                        ? "school_and_sector"
                        : "school_only",

                    classes: []
                });

            }

            const test = testsMap.get(testKey);

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
                    subjects: [],
                    students: []
                };

                test.classes.push(classItem);
            }

            /* -----------------------------------------
               SUBJECTS
            ----------------------------------------- */

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

            /* -----------------------------------------
               ACTIVE STUDENTS
            ----------------------------------------- */

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

        console.error("School Marks loading error:", error);

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
