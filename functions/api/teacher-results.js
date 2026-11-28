
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

    // Optional subclass filter. Missing or empty means All Subclasses.
    const subclassParam = url.searchParams.get("subclass_id");
    const subclassId = subclassParam
        ? validId(subclassParam)
        : null;

    if (!academicYearId || !termId) {
        return json({
            success: false,
            message: "Please select an academic year and term."
        }, 400);
    }

    if (subclassParam && !subclassId) {
        return json({
            success: false,
            message: "Invalid subclass selection."
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
           1. IDENTIFY TEACHER AND SCHOOL
        ================================================= */

        if (auth.role === "teacher") {
            schoolId = validId(auth.schoolId);

            if (!schoolId) {
                return json({
                    success: false,
                    message: "Your account is not linked to a school."
                }, 403);
            }

            const result = await client.query(
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
                [auth.userId, schoolId]
            );

            if (!result.rowCount) {
                return json({
                    success: false,
                    message: "Your teacher profile could not be found."
                }, 404);
            }

            teacherId = validId(result.rows[0].id);
            teacherName = result.rows[0].full_name;
            schoolName = result.rows[0].school_name;
        }

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

            const result = await client.query(
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
                [teacherId, schoolId]
            );

            if (!result.rowCount) {
                return json({
                    success: false,
                    message: "This teacher does not belong to your school."
                }, 403);
            }

            teacherId = validId(result.rows[0].id);
            teacherName = result.rows[0].full_name;
            schoolName = result.rows[0].school_name;
        }

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

            const result = await client.query(
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
                [teacherId, schoolId, auth.sectorId]
            );

            if (!result.rowCount) {
                return json({
                    success: false,
                    message: "This teacher is not accessible within your sector."
                }, 403);
            }

            teacherId = validId(result.rows[0].id);
            teacherName = result.rows[0].full_name;
            schoolName = result.rows[0].school_name;
        }

        /* =================================================
           2. VALIDATE ACADEMIC PERIOD
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
            [schoolId, academicYearId, termId]
        );

        if (!periodResult.rowCount) {
            return json({
                success: false,
                message: "The selected academic year or term does not belong to this school."
            }, 400);
        }

        const academicPeriod = periodResult.rows[0];

        /* =================================================
           3. GET TEACHER ASSIGNMENTS
        ================================================= */

        const assignmentResult = await client.query(
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
                sub.subject_name

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

            WHERE ta.teacher_id = $1
              AND ta.school_id = $2

            ORDER BY
                c.class_name,
                sub.subject_name
            `,
            [teacherId, schoolId]
        );

        /* =================================================
           4. VALIDATE SELECTED SUBCLASS
        ================================================= */

        if (subclassId) {
            const subclassValidation = await client.query(
                `
                SELECT scs.id
                FROM school_class_subclasses scs

                WHERE scs.id = $1
                  AND scs.school_id = $2
                  AND scs.academic_year_id = $3
                  AND LOWER(TRIM(scs.status)) = 'active'

                  AND EXISTS (
                      SELECT 1
                      FROM teacher_assignments ta
                      WHERE ta.teacher_id = $4
                        AND ta.school_id = $2
                        AND ta.class_id = scs.class_id
                  )

                LIMIT 1
                `,
                [
                    subclassId,
                    schoolId,
                    academicYearId,
                    teacherId
                ]
            );

            if (!subclassValidation.rowCount) {
                return json({
                    success: false,
                    message: "The selected subclass is not available for this teacher, school or academic year."
                }, 400);
            }
        }

        const assignments = [];

        /* =================================================
           5. LOAD STUDENTS, TESTS AND EXAMINATIONS
        ================================================= */

        for (const assignmentRow of assignmentResult.rows) {
            const assignment = {
                assignment_id: String(assignmentRow.assignment_id),
                school_id: String(assignmentRow.school_id),
                school_name: assignmentRow.school_name,
                teacher_id: String(assignmentRow.teacher_id),
                class_id: String(assignmentRow.class_id),
                class_name: assignmentRow.class_name,
                class_level: assignmentRow.class_level,
                subject_id: String(assignmentRow.subject_id),
                subject_name: assignmentRow.subject_name,

                // Active subclasses for this class and academic year.
                subclasses: [],

                tests: [],
                examinations: []
            };

            /* -----------------------------------------
               5A. LOAD SUBCLASSES FOR THIS CLASS
            ----------------------------------------- */

            const subclassResult = await client.query(
                `
                SELECT
                    id,
                    subclass_name
                FROM school_class_subclasses
                WHERE school_id = $1
                  AND academic_year_id = $2
                  AND class_id = $3
                  AND LOWER(TRIM(status)) = 'active'
                ORDER BY subclass_name ASC, id ASC
                `,
                [
                    schoolId,
                    academicYearId,
                    assignmentRow.class_id
                ]
            );

            assignment.subclasses = subclassResult.rows.map(
                subclass => ({
                    id: String(subclass.id),
                    name: subclass.subclass_name
                })
            );

            /* -----------------------------------------
               5B. STUDENTS IN THE SELECTED PERIOD
            ----------------------------------------- */

            const studentResult = await client.query(
                `
                SELECT DISTINCT ON (st.id)
                    st.id,
                    st.full_name,
                    st.student_code,
                    st.gender,
                    se.subclass_id

                FROM student_enrollments se

                INNER JOIN students st
                    ON st.id = se.student_id
                   AND st.school_id = se.school_id
                   AND st.class_id = se.class_id
                   AND st.status = 'active'

                WHERE se.school_id = $1
                  AND se.class_id = $2
                  AND se.academic_year_id = $3
                  AND se.term_id = $4
                  AND LOWER(TRIM(se.status)) = 'active'

                  AND (
                      $5::bigint IS NULL
                      OR se.subclass_id = $5
                  )

                ORDER BY
                    st.id,
                    se.created_at DESC,
                    se.id DESC,
                    st.full_name
                `,
                [
                    schoolId,
                    assignmentRow.class_id,
                    academicYearId,
                    termId,
                    subclassId
                ]
            );

            const students = studentResult.rows.map(student => ({
                id: String(student.id),
                name: student.full_name,
                student_code: student.student_code,
                gender: student.gender,

                // NULL means the student has not been allocated
                // to a subclass in this enrollment.
                subclass_id: student.subclass_id === null
                    ? null
                    : String(student.subclass_id)
            }));

            /* -----------------------------------------
               5C. TESTS
            ----------------------------------------- */

            const testResult = await client.query(
                `
                SELECT DISTINCT
                    tst.id,
                    tst.test_name,
                    tst.status,
                    tst.created_at,
                    ts.total_marks AS maximum_mark

                FROM test_classes tc

                INNER JOIN test_schools tsc
                    ON tsc.test_id = tc.test_id
                   AND tsc.school_id = tc.school_id
                   AND tsc.academic_year_id = $3
                   AND tsc.term_id = $4

                INNER JOIN tests tst
                    ON tst.id = tc.test_id

                INNER JOIN test_subjects ts
                    ON ts.test_id = tst.id
                   AND ts.subject_id = $5

                WHERE tc.school_id = $1
                  AND tc.class_id = $2

                ORDER BY tst.created_at, tst.id
                `,
                [
                    schoolId,
                    assignmentRow.class_id,
                    academicYearId,
                    termId,
                    assignmentRow.subject_id
                ]
            );

            const testIds = testResult.rows.map(
                row => String(row.id)
            );

            /* -----------------------------------------
               5D. TEST MARKS
            ----------------------------------------- */

            let testMarks = [];

            if (testIds.length) {
                const marksResult = await client.query(
                    `
                    SELECT
                        m.test_id,
                        m.student_id,
                        m.score
                    FROM marks m
                    WHERE m.test_id = ANY($1::bigint[])
                      AND m.class_id = $2
                      AND m.subject_id = $3
                    `,
                    [
                        testIds,
                        assignmentRow.class_id,
                        assignmentRow.subject_id
                    ]
                );

                testMarks = marksResult.rows;
            }

            const testMarkMap = new Map();

            for (const mark of testMarks) {
                testMarkMap.set(
                    `${mark.test_id}:${mark.student_id}`,
                    mark.score === null
                        ? null
                        : Number(mark.score)
                );
            }

            assignment.tests = testResult.rows.map(test => ({
                id: String(test.id),
                name: test.test_name,
                status: test.status,
                created_at: test.created_at,

                maximum_mark: test.maximum_mark === null
                    ? 0
                    : Number(test.maximum_mark),

                students: students.map(student => ({
                    ...student,
                    mark: testMarkMap.has(
                        `${test.id}:${student.id}`
                    )
                        ? testMarkMap.get(
                            `${test.id}:${student.id}`
                        )
                        : null
                }))
            }));

            /* -----------------------------------------
               5E. EXAMINATIONS
            ----------------------------------------- */

            const examinationResult = await client.query(
                `
                SELECT
                    e.id,
                    e.exam_name,
                    e.exam_type,
                    e.total_marks,
                    e.exam_date,
                    e.created_at

                FROM examinations e

                WHERE e.school_id = $1
                  AND e.class_id = $2
                  AND e.subject_id = $3
                  AND e.academic_year_id = $4
                  AND e.term_id = $5

                ORDER BY
                    e.exam_date NULLS LAST,
                    e.created_at,
                    e.id
                `,
                [
                    schoolId,
                    assignmentRow.class_id,
                    assignmentRow.subject_id,
                    academicYearId,
                    termId
                ]
            );

            const examinationIds = examinationResult.rows.map(
                row => String(row.id)
            );

            /* -----------------------------------------
               5F. EXAMINATION MARKS
            ----------------------------------------- */

            let examinationMarks = [];

            if (examinationIds.length) {
                const marksResult = await client.query(
                    `
                    SELECT
                        m.examination_id,
                        m.student_id,
                        m.score

                    FROM marks m

                    WHERE m.examination_id = ANY($1::bigint[])
                      AND m.class_id = $2
                      AND m.subject_id = $3
                    `,
                    [
                        examinationIds,
                        assignmentRow.class_id,
                        assignmentRow.subject_id
                    ]
                );

                examinationMarks = marksResult.rows;
            }

            const examinationMarkMap = new Map();

            for (const mark of examinationMarks) {
                examinationMarkMap.set(
                    `${mark.examination_id}:${mark.student_id}`,
                    mark.score === null
                        ? null
                        : Number(mark.score)
                );
            }

            assignment.examinations =
                examinationResult.rows.map(examination => ({
                    id: String(examination.id),
                    name: examination.exam_name,
                    exam_type: examination.exam_type,
                    exam_date: examination.exam_date,
                    created_at: examination.created_at,

                    maximum_mark: Number(
                        examination.total_marks
                    ),

                    students: students.map(student => ({
                        ...student,
                        mark: examinationMarkMap.has(
                            `${examination.id}:${student.id}`
                        )
                            ? examinationMarkMap.get(
                                `${examination.id}:${student.id}`
                            )
                            : null
                    }))
                }));

            assignments.push(assignment);
        }

        /* =================================================
           6. RESPONSE
        ================================================= */

        return json({
            success: true,

            academic_period: {
                academic_year_id: String(
                    academicPeriod.academic_year_id
                ),
                academic_year: academicPeriod.year_name,
                term_id: String(academicPeriod.term_id),
                term: academicPeriod.term_name,
                term_number: Number(academicPeriod.term_number)
            },

            teacher: {
                id: String(teacherId),
                full_name: teacherName,
                school_id: String(schoolId),
                school_name: schoolName
            },

            selected_subclass_id: subclassId
                ? String(subclassId)
                : null,

            assignments
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
