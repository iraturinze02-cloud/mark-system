
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

function number(value) {
    return Number(value || 0);
}

function round(value) {
    return Math.round(
        (Number(value) + Number.EPSILON) * 100
    ) / 100;
}

/* =====================================================
   CHECK THAT TEST BELONGS TO THE ADMIN'S SCHOOL
===================================================== */

async function getSchoolTest(client, testId, schoolId) {

    const result = await client.query(
        `SELECT
            t.id,
            t.test_name,
            t.status,
            t.created_at

         FROM tests t

         WHERE t.id = $1

           AND (
                t.school_id = $2

                OR EXISTS (
                    SELECT 1
                    FROM test_schools tst
                    WHERE tst.test_id = t.id
                      AND tst.school_id = $2
                )
           )

         LIMIT 1`,
        [testId, schoolId]
    );

    return result.rows[0] || null;
}

/* =====================================================
   GET AVAILABLE TESTS FOR THIS SCHOOL ONLY
===================================================== */

async function getTests(client, schoolId) {

    const result = await client.query(
        `SELECT
            t.id,
            t.test_name AS name,
            t.status,
            t.created_at

         FROM tests t

         WHERE (
                t.school_id = $1

                OR EXISTS (
                    SELECT 1
                    FROM test_schools tst
                    WHERE tst.test_id = t.id
                      AND tst.school_id = $1
                )
         )

         ORDER BY t.created_at DESC, t.id DESC`,
        [schoolId]
    );

    return result.rows.map(row => ({
        id: String(row.id),
        name: row.name,
        status: row.status,
        created_at: row.created_at
    }));
}

/* =====================================================
   SUBJECT PERFORMANCE

   Includes ALL subjects in the selected test
   for this school's participating test classes.

   Candidates:
   - This school's participating test classes
   - Active students

   Pass mark: 50% or above.

   Percentage:
   Passed / Total Candidates * 100
===================================================== */

async function getSubjectPerformance(
    client,
    testId,
    schoolId
) {

    const result = await client.query(
        `WITH eligible_subject_classes AS (

            SELECT DISTINCT
                ts.subject_id,
                tc.class_id,
                tc.school_id,
                ts.total_marks

            FROM test_subjects ts

            INNER JOIN test_classes tc
                ON tc.test_id = ts.test_id

            WHERE ts.test_id = $1
              AND tc.school_id = $2
        ),

        candidates AS (

            SELECT
                esc.subject_id,
                esc.total_marks,
                esc.school_id,
                esc.class_id,
                st.id AS student_id

            FROM eligible_subject_classes esc

            INNER JOIN students st
                ON st.school_id = esc.school_id
               AND st.class_id = esc.class_id
               AND st.status = 'active'
        )

        SELECT
            sub.id AS subject_id,
            sub.subject_name,

            COUNT(DISTINCT c.student_id)
                AS total_candidates,

            COUNT(DISTINCT c.student_id)
                FILTER (
                    WHERE m.score IS NOT NULL
                ) AS recorded,

            COUNT(DISTINCT c.student_id)
                FILTER (
                    WHERE m.score IS NOT NULL
                      AND c.total_marks IS NOT NULL
                      AND m.score >= c.total_marks * 0.5
                ) AS passed,

            COUNT(DISTINCT c.student_id)
                FILTER (
                    WHERE m.score IS NOT NULL
                      AND c.total_marks IS NOT NULL
                      AND m.score < c.total_marks * 0.5
                ) AS failed,

            ROUND(
                AVG(m.score)::numeric,
                2
            ) AS average,

            ROUND(
                (
                    COUNT(DISTINCT c.student_id)
                    FILTER (
                        WHERE m.score IS NOT NULL
                          AND c.total_marks IS NOT NULL
                          AND m.score >= c.total_marks * 0.5
                    )::numeric
                    /
                    NULLIF(
                        COUNT(DISTINCT c.student_id),
                        0
                    )
                ) * 100,
                2
            ) AS percentage

        FROM candidates c

        INNER JOIN subjects sub
            ON sub.id = c.subject_id

        LEFT JOIN LATERAL (
            SELECT
                mk.score

            FROM marks mk

            WHERE mk.test_id = $1
              AND mk.student_id = c.student_id
              AND mk.class_id = c.class_id
              AND mk.subject_id = c.subject_id

            ORDER BY mk.updated_at DESC, mk.id DESC

            LIMIT 1
        ) m ON TRUE

        GROUP BY
            sub.id,
            sub.subject_name

        ORDER BY
            percentage DESC NULLS LAST,
            passed DESC,
            average DESC NULLS LAST`,
        [testId, schoolId]
    );

    return result.rows.map(row => {

        const total = number(row.total_candidates);
        const recorded = number(row.recorded);
        const passed = number(row.passed);

        return {
            id: String(row.subject_id),
            name: row.subject_name,

            total_candidates: total,
            recorded,

            missing: Math.max(0, total - recorded),

            passed,
            failed: number(row.failed),

            average: number(row.average),

            percentage: total > 0
                ? round((passed / total) * 100)
                : 0,

            pass_rate: total > 0
                ? round((passed / total) * 100)
                : 0,

            status: total > 0 && recorded >= total
                ? "completed"
                : "pending"
        };
    });
}

/* =====================================================
   TEACHER PERFORMANCE BY CLASS AND SUBJECT

   Only teachers assigned to the authenticated
   school are included.

   Percentage:
   Passed / Total Candidates * 100
===================================================== */

async function getTeacherPerformance(
    client,
    testId,
    schoolId
) {

    const result = await client.query(
        `SELECT
            t.id AS teacher_id,
            u.full_name AS teacher_name,

            sch.id AS school_id,
            sch.school_name,

            sub.id AS subject_id,
            sub.subject_name,

            c.id AS class_id,
            c.class_name,

            ts.total_marks,

            COUNT(DISTINCT st.id)
                AS total_candidates,

            COUNT(DISTINCT st.id)
                FILTER (
                    WHERE m.score IS NOT NULL
                ) AS recorded,

            COUNT(DISTINCT st.id)
                FILTER (
                    WHERE m.score IS NOT NULL
                      AND ts.total_marks IS NOT NULL
                      AND m.score >= ts.total_marks * 0.5
                ) AS passed,

            COUNT(DISTINCT st.id)
                FILTER (
                    WHERE m.score IS NOT NULL
                      AND ts.total_marks IS NOT NULL
                      AND m.score < ts.total_marks * 0.5
                ) AS failed,

            SUM(m.score) AS score_sum

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
           AND sch.id = $2

        INNER JOIN classes c
            ON c.id = ta.class_id

        INNER JOIN subjects sub
            ON sub.id = ta.subject_id

        INNER JOIN test_classes tc
            ON tc.test_id = $1
           AND tc.school_id = ta.school_id
           AND tc.class_id = ta.class_id

        INNER JOIN test_subjects ts
            ON ts.test_id = $1
           AND ts.subject_id = ta.subject_id

        LEFT JOIN students st
            ON st.school_id = ta.school_id
           AND st.class_id = ta.class_id
           AND st.status = 'active'

        LEFT JOIN LATERAL (
            SELECT
                mk.score

            FROM marks mk

            WHERE mk.test_id = $1
              AND mk.student_id = st.id
              AND mk.class_id = ta.class_id
              AND mk.subject_id = ta.subject_id

            ORDER BY mk.updated_at DESC, mk.id DESC

            LIMIT 1
        ) m ON TRUE

        WHERE ta.school_id = $2

        GROUP BY
            t.id,
            u.full_name,
            sch.id,
            sch.school_name,
            sub.id,
            sub.subject_name,
            c.id,
            c.class_name,
            ts.total_marks

        ORDER BY
            u.full_name,
            sub.subject_name,
            c.class_name`,
        [testId, schoolId]
    );

    /* ---------------------------------------------
       ORGANIZE CLASS BREAKDOWNS BY TEACHER + SUBJECT
    --------------------------------------------- */

    const teachersMap = new Map();

    for (const row of result.rows) {

        const teacherId = String(row.teacher_id);
        const subjectId = String(row.subject_id);

        const teacherKey =
            `${teacherId}_${row.school_id}_${subjectId}`;

        const total = number(row.total_candidates);
        const recorded = number(row.recorded);
        const passed = number(row.passed);
        const failed = number(row.failed);

        const scoreSum = number(row.score_sum);

        const breakdown = {

            class_id: String(row.class_id),
            class_name: row.class_name,

            subject: row.subject_name,
            subject_id: subjectId,

            total_candidates: total,
            recorded,

            missing: Math.max(0, total - recorded),

            passed,
            failed,

            average: recorded > 0
                ? round(scoreSum / recorded)
                : 0,

            percentage: total > 0
                ? round((passed / total) * 100)
                : 0,

            pass_rate: total > 0
                ? round((passed / total) * 100)
                : 0,

            status: total > 0 && recorded >= total
                ? "completed"
                : "pending"
        };

        if (!teachersMap.has(teacherKey)) {

            teachersMap.set(teacherKey, {

                teacher_id: teacherId,
                teacher: row.teacher_name,

                school_id: String(row.school_id),
                school: row.school_name,

                subject_id: subjectId,
                subject: row.subject_name,

                total_candidates: 0,
                recorded: 0,
                missing: 0,

                passed: 0,
                failed: 0,

                score_sum: 0,

                breakdown: []
            });
        }

        const teacher = teachersMap.get(teacherKey);

        teacher.total_candidates += total;
        teacher.recorded += recorded;
        teacher.missing += Math.max(0, total - recorded);

        teacher.passed += passed;
        teacher.failed += failed;

        teacher.score_sum += scoreSum;

        teacher.breakdown.push(breakdown);
    }

    /* ---------------------------------------------
       FINAL TEACHER STATISTICS
    --------------------------------------------- */

    return Array.from(teachersMap.values()).map(teacher => {

        const recorded = teacher.recorded;
        const total = teacher.total_candidates;

        const average = recorded > 0
            ? round(teacher.score_sum / recorded)
            : 0;

        const percentage = total > 0
            ? round((teacher.passed / total) * 100)
            : 0;

        return {

            teacher_id: teacher.teacher_id,
            teacher: teacher.teacher,

            school_id: teacher.school_id,
            school: teacher.school,

            subject_id: teacher.subject_id,
            subject: teacher.subject,

            total_candidates: total,
            recorded,
            missing: teacher.missing,

            passed: teacher.passed,
            failed: teacher.failed,

            average,
            percentage,

            pass_rate: percentage,

            status: total > 0 && recorded >= total
                ? "completed"
                : "pending",

            breakdown: teacher.breakdown
        };
    });
}

/* =====================================================
   GET: SCHOOL TEACHERS' PERFORMANCE
===================================================== */

export async function onRequestGet(context) {

    const auth = await authenticateRole(
        context,
        ["school_admin", "dos"]
    );

    if (auth.error) return auth.error;

    /* ---------------------------------------------
       GET SCHOOL ID FROM AUTHENTICATED USER
    --------------------------------------------- */

    const schoolId = validId(auth.schoolId);

    if (!schoolId) {

        return json({
            success: false,
            message: "Your account is not linked to a school."
        }, 403);
    }

    const url = new URL(context.request.url);

    const requestedTestId =
        url.searchParams.get("test_id");

    let client;

    try {

        client = await connectDB(context);

        /* ---------------------------------------------
           LOAD THIS SCHOOL'S TESTS
        --------------------------------------------- */

        if (!requestedTestId) {

            const tests = await getTests(
                client,
                schoolId
            );

            return json({

                success: true,

                user: {
                    id: auth.userId,
                    role: auth.role
                },

                tests
            });
        }

        /* ---------------------------------------------
           VALIDATE SELECTED TEST
        --------------------------------------------- */

        const testId = validId(requestedTestId);

        if (!testId) {

            return json({
                success: false,
                message: "Please select a valid test."
            }, 400);
        }

        const test = await getSchoolTest(
            client,
            testId,
            schoolId
        );

        if (!test) {

            return json({
                success: false,
                message: "This test is not accessible within your school."
            }, 403);
        }

        /* ---------------------------------------------
           LOAD ONLY THIS SCHOOL'S PERFORMANCE
        --------------------------------------------- */

        const subjects = await getSubjectPerformance(
            client,
            testId,
            schoolId
        );

        const teachers = await getTeacherPerformance(
            client,
            testId,
            schoolId
        );

        /* ---------------------------------------------
           SUCCESS RESPONSE
        --------------------------------------------- */

        return json({

            success: true,

            user: {
                id: auth.userId,
                role: auth.role
            },

            test: {
                id: String(test.id),
                name: test.test_name,
                status: test.status,
                created_at: test.created_at
            },

            subjects,
            teachers
        });

    } catch (error) {

        console.error(
            "School Teachers Performance API error:",
            {
                message: error?.message,
                code: error?.code,
                detail: error?.detail,
                table: error?.table,
                constraint: error?.constraint
            }
        );

        return json({
            success: false,
            message: "Unable to load school teachers' performance."
        }, 500);

    } finally {

        if (client) {
            await client.end().catch(() => {});
        }
    }
}
