
import {
    connectDB,
    authenticateRole,
    json
} from "../_utils.js";

/* =====================================================
   SCHOOL REPORT CARDS

   ACCESS:
   - School admin only.

   SECTOR-ADMIN-CREATED TEST:
   - Load participating schools in the admin's sector.
   - Calculate school and sector positions.
   - Return report cards only for the admin's school.

   SCHOOL-ADMIN-CREATED TEST:
   - Load only the admin's school.
   - Calculate school positions only.
===================================================== */

function calculatePerformance(student, subjects) {
    let total = 0;
    let maximum = 0;
    let complete = true;

    for (const subject of subjects) {
        const maxMark = Number(subject.maximum_mark || 0);
        const mark = student.marks[subject.id];

        maximum += maxMark;

        if (
            mark === null ||
            mark === undefined ||
            !Number.isFinite(Number(mark))
        ) {
            complete = false;
        } else {
            total += Number(mark);
        }
    }

    if (!complete || maximum <= 0) {
        return {
            complete: false,
            total: null,
            maximum,
            percentage: null,
            position: null
        };
    }

    return {
        complete: true,
        total,
        maximum,
        percentage: (total / maximum) * 100,
        position: null
    };
}

/* =====================================================
   ASSIGN RANKS

   Competition ranking:
   1, 1, 3
===================================================== */

function assignRanks(students, performanceMap) {
    const eligible = students
        .filter(student => {
            const result = performanceMap.get(student.id);
            return result && result.complete;
        })
        .slice()
        .sort((a, b) => {
            return performanceMap.get(b.id).percentage -
                   performanceMap.get(a.id).percentage;
        });

    let previousPercentage = null;
    let previousPosition = null;

    eligible.forEach((student, index) => {
        const percentage = Number(
            performanceMap.get(student.id).percentage.toFixed(6)
        );

        if (percentage === previousPercentage) {
            performanceMap.get(student.id).position = previousPosition;
        } else {
            const position = index + 1;

            performanceMap.get(student.id).position = position;

            previousPercentage = percentage;
            previousPosition = position;
        }
    });
}

/* =====================================================
   GET REPORT CARDS
===================================================== */

export async function onRequestGet(context) {

    const auth = await authenticateRole(context, [
        "school_admin"
    ]);

    if (auth.error) return auth.error;

    const schoolId = String(auth.schoolId || "");
    const sectorId = String(auth.sectorId || "");

    if (!schoolId) {
        return json({
            success: false,
            message: "Your account is not linked to a school."
        }, 403);
    }

    const url = new URL(context.request.url);
    const testId = url.searchParams.get("test_id");

    if (!testId || !/^\d+$/.test(testId)) {
        return json({
            success: false,
            message: "A valid test_id is required."
        }, 400);
    }

    let client;

    try {
        client = await connectDB(context);

        /* ---------------------------------------------
           1. VERIFY TEST ACCESS AND CREATOR
        --------------------------------------------- */

        const testResult = await client.query(
            `
            SELECT
                t.id,
                t.test_name,
                t.status,
                t.created_at,
                t.created_by,
                t.sector_id,
                t.school_id,

                creator.full_name AS creator_name,
                creator.role AS creator_role

            FROM tests t

            INNER JOIN users creator
                ON creator.id = t.created_by

            WHERE t.id = $1

              AND (
                    (
                        creator.role = 'sector_admin'
                        AND t.sector_id = $2
                        AND EXISTS (
                            SELECT 1
                            FROM test_classes own_tc
                            WHERE own_tc.test_id = t.id
                              AND own_tc.school_id = $3
                        )
                    )

                    OR

                    (
                        creator.role = 'school_admin'
                        AND t.school_id = $3
                    )
              )

            LIMIT 1
            `,
            [testId, sectorId, schoolId]
        );

        if (testResult.rows.length === 0) {
            return json({
                success: false,
                message: "This test is not available to your school."
            }, 404);
        }

        const test = testResult.rows[0];

        const isSectorTest =
            test.creator_role === "sector_admin";

        if (
            !isSectorTest &&
            test.creator_role !== "school_admin"
        ) {
            return json({
                success: false,
                message: "Unsupported test creator role."
            }, 403);
        }

        /* ---------------------------------------------
           2. LOAD PARTICIPATING SCHOOL RESULTS

           Sector test:
           All participating schools in the sector.

           School test:
           Only the creator's school.
        --------------------------------------------- */

        let schoolCondition = "";
        let parameters = [testId];

        if (isSectorTest) {

            schoolCondition = `
                EXISTS (
                    SELECT 1
                    FROM schools scope_school
                    WHERE scope_school.id = tc.school_id
                      AND scope_school.sector_id = $2
                )
            `;

            parameters.push(sectorId);

        } else {

            schoolCondition = `
                tc.school_id = $2
            `;

            parameters.push(schoolId);
        }

        const result = await client.query(
            `
            SELECT
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

            FROM test_classes tc

            INNER JOIN schools sch
                ON sch.id = tc.school_id

            INNER JOIN classes c
                ON c.id = tc.class_id

            INNER JOIN school_levels sl
                ON sl.school_id = tc.school_id
               AND sl.level_id = c.level_id

            INNER JOIN test_subjects ts
                ON ts.test_id = tc.test_id

            INNER JOIN subjects sub
                ON sub.id = ts.subject_id

            LEFT JOIN students st
                ON st.school_id = tc.school_id
               AND st.class_id = tc.class_id
               AND st.status = 'active'

            LEFT JOIN marks m
                ON m.test_id = tc.test_id
               AND m.student_id = st.id
               AND m.class_id = c.id
               AND m.subject_id = sub.id

            WHERE tc.test_id = $1
              AND ${schoolCondition}

            ORDER BY
                sch.school_name,
                c.class_name,
                st.full_name,
                sub.subject_name
            `,
            parameters
        );

        /* ---------------------------------------------
           3. ORGANIZE ALL PARTICIPATING SCHOOLS
        --------------------------------------------- */

        const classesMap = new Map();

        for (const row of result.rows) {

            const classKey =
                `${row.school_id}_${row.class_id}`;

            if (!classesMap.has(classKey)) {
                classesMap.set(classKey, {
                    school_id: String(row.school_id),
                    school_name: row.school_name,

                    class_id: String(row.class_id),
                    class_name: row.class_name,
                    class_level: row.class_level,

                    subjects: [],
                    students: []
                });
            }

            const classItem = classesMap.get(classKey);

            /* Subjects */

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

            /* Students */

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

        const allClasses = Array.from(classesMap.values());

        /* ---------------------------------------------
           4. CALCULATE SCHOOL POSITIONS
        --------------------------------------------- */

        for (const classItem of allClasses) {

            const performanceMap = new Map();

            for (const student of classItem.students) {
                performanceMap.set(
                    student.id,
                    calculatePerformance(
                        student,
                        classItem.subjects
                    )
                );
            }

            assignRanks(
                classItem.students,
                performanceMap
            );

            for (const student of classItem.students) {
                const performance =
                    performanceMap.get(student.id);

                student.school_position =
                    performance.position;

                student.sector_position = null;

                student.total = performance.total;
                student.maximum = performance.maximum;
                student.percentage = performance.percentage;
                student.complete = performance.complete;
            }
        }

        /* ---------------------------------------------
           5. CALCULATE SECTOR POSITIONS

           Compare the same class across all schools.
        --------------------------------------------- */

        if (isSectorTest) {

            const sectorGroups = new Map();

            for (const classItem of allClasses) {

                const classKey = String(classItem.class_id);

                if (!sectorGroups.has(classKey)) {
                    sectorGroups.set(classKey, []);
                }

                sectorGroups.get(classKey).push(
                    ...classItem.students
                );
            }

            for (const students of sectorGroups.values()) {

                const performanceMap = new Map();

                for (const student of students) {
                    performanceMap.set(
                        student.id,
                        {
                            complete: student.complete,
                            percentage: student.percentage,
                            position: null
                        }
                    );
                }

                assignRanks(students, performanceMap);

                for (const student of students) {
                    student.sector_position =
                        performanceMap.get(student.id).position;
                }
            }
        }

        /* ---------------------------------------------
           6. RETURN ONLY THIS SCHOOL'S REPORT CARDS

           Other schools are used for sector ranking,
           but their student records are not returned.
        --------------------------------------------- */

        const ownClasses = allClasses.filter(
            classItem =>
                String(classItem.school_id) === schoolId
        );

        return json({
            success: true,

            test: {
                id: String(test.id),
                name: test.test_name,
                status: test.status,
                created_at: test.created_at,
                creator_name: test.creator_name,
                creator_role: test.creator_role,

                report_card_type: isSectorTest
                    ? "school_and_sector"
                    : "school_only"
            },

            school: {
                id: schoolId
            },

            classes: ownClasses
        });

    } catch (error) {

        console.error(
            "School report cards error:",
            error
        );

        return json({
            success: false,
            message: "Unable to generate report cards."
        }, 500);

    } finally {

        if (client) {
            await client.end().catch(() => {});
        }
    }
}
