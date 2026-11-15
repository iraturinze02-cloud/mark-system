
import {
    connectDB,
    authenticateRole,
    json
} from "../_utils.js";

/* =====================================================
   GET: SCHOOL MARKS — VIEW ONLY
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
        }

        /* ---------------------------------------------
           SCHOOL ADMIN
           Only their own school's classes and tests.
        --------------------------------------------- */

        else {
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
           LOAD TESTS, CLASSES, STUDENTS AND MARKS

           IMPORTANT:
           - No test status restriction.
           - No UPDATE statements.
           - Students without marks are included.
        --------------------------------------------- */

        const result = await client.query(
            `
            SELECT
                t.id AS test_id,
                t.test_name,
                t.status,
                t.created_at AS test_created_at,

                tc.school_id,

                sch.school_name,

                c.id AS class_id,
                c.class_name,
                c.class_level,

                st.id AS student_id,
                st.full_name AS student_name,
                st.student_code,

                sub.id AS subject_id,
                sub.subject_name,
                sub.subject_code,

                ts.total_marks AS maximum_mark,

                m.score

            FROM tests t

            INNER JOIN test_classes tc
                ON tc.test_id = t.id

            INNER JOIN classes c
                ON c.id = tc.class_id
               AND c.school_id = tc.school_id

            INNER JOIN schools sch
                ON sch.id = tc.school_id

            LEFT JOIN students st
                ON st.class_id = c.id
               AND st.school_id = tc.school_id

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

            /* SUBJECTS */

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

            /* STUDENTS */

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
