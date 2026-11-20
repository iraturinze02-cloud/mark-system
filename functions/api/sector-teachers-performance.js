
import {
    connectDB,
    json,
    requireSectorAdmin
} from "../_utils.js";

/* =====================================================
   HELPERS
===================================================== */

function toNumber(value) {
    return Number(value || 0);
}

function round(value) {
    return Math.round(value * 100) / 100;
}

function calculateStatus(recorded, total) {
    return total > 0 && recorded >= total
        ? "completed"
        : "pending";
}

/* =====================================================
   GET TESTS AVAILABLE TO THE SECTOR
===================================================== */

async function getSectorTests(client, sectorId) {
    const result = await client.query(
        `SELECT DISTINCT
            t.id::text AS id,
            t.test_name AS name,
            t.status,
            t.created_at
         FROM tests t
         WHERE
            t.sector_id = $1

            OR (
                t.school_id IS NOT NULL
                AND EXISTS (
                    SELECT 1
                    FROM schools s
                    WHERE s.id = t.school_id
                    AND s.sector_id = $1
                )
            )

            OR EXISTS (
                SELECT 1
                FROM test_classes tc
                JOIN schools s
                    ON s.id = tc.school_id
                WHERE tc.test_id = t.id
                AND s.sector_id = $1
            )

         ORDER BY t.created_at DESC`,
        [sectorId]
    );

    return result.rows;
}

/* =====================================================
   VERIFY THAT THE TEST BELONGS TO THE SECTOR
===================================================== */

async function verifyTest(client, testId, sectorId) {
    const result = await client.query(
        `SELECT t.id
         FROM tests t
         WHERE t.id = $1
         AND (
            t.sector_id = $2

            OR (
                t.school_id IS NOT NULL
                AND EXISTS (
                    SELECT 1
                    FROM schools s
                    WHERE s.id = t.school_id
                    AND s.sector_id = $2
                )
            )

            OR EXISTS (
                SELECT 1
                FROM test_classes tc
                JOIN schools s
                    ON s.id = tc.school_id
                WHERE tc.test_id = t.id
                AND s.sector_id = $2
            )
         )
         LIMIT 1`,
        [testId, sectorId]
    );

    return result.rows.length > 0;
}

/* =====================================================
   SUBJECT PERFORMANCE
===================================================== */

async function getSubjectPerformance(
    client,
    testId,
    sectorId
) {
    const result = await client.query(
        `WITH scoped_classes AS (
            SELECT DISTINCT
                tc.school_id,
                tc.class_id
            FROM test_classes tc
            JOIN schools s
                ON s.id = tc.school_id
            WHERE tc.test_id = $1
            AND s.sector_id = $2
        ),

        latest_marks AS (
            SELECT DISTINCT ON (
                m.test_id,
                m.student_id,
                m.class_id,
                m.subject_id
            )
                m.id,
                m.test_id,
                m.student_id,
                m.class_id,
                m.subject_id,
                m.score
            FROM marks m
            WHERE m.test_id = $1
            ORDER BY
                m.test_id,
                m.student_id,
                m.class_id,
                m.subject_id,
                m.updated_at DESC NULLS LAST,
                m.created_at DESC NULLS LAST,
                m.id DESC
        ),

        candidates AS (
            SELECT
                ts.subject_id,
                sub.subject_name,
                ts.total_marks,
                st.id AS student_id,
                lm.id AS mark_id,
                lm.score

            FROM scoped_classes sc

            JOIN students st
                ON st.class_id = sc.class_id
                AND st.school_id = sc.school_id

            JOIN test_subjects ts
                ON ts.test_id = $1

            JOIN subjects sub
                ON sub.id = ts.subject_id

            LEFT JOIN latest_marks lm
                ON lm.student_id = st.id
                AND lm.class_id = sc.class_id
                AND lm.subject_id = ts.subject_id
        )

        SELECT
            subject_id::text,
            subject_name,

            COUNT(*) AS total_candidates,

            COUNT(mark_id) AS recorded,

            COUNT(*) - COUNT(mark_id) AS missing,

            COUNT(*) FILTER (
                WHERE mark_id IS NOT NULL
                AND score >= total_marks * 0.5
            ) AS passed,

            COUNT(*) FILTER (
                WHERE mark_id IS NOT NULL
                AND score < total_marks * 0.5
            ) AS failed,

            ROUND(
                AVG(score) FILTER (
                    WHERE mark_id IS NOT NULL
                ),
                2
            ) AS average,

            ROUND(
                AVG(
                    score / NULLIF(total_marks, 0) * 100
                ) FILTER (
                    WHERE mark_id IS NOT NULL
                ),
                2
            ) AS percentage,

            ROUND(
                COUNT(*) FILTER (
                    WHERE mark_id IS NOT NULL
                    AND score >= total_marks * 0.5
                )::numeric
                /
                NULLIF(COUNT(mark_id), 0)
                * 100,
                2
            ) AS pass_rate

        FROM candidates

        GROUP BY
            subject_id,
            subject_name

        ORDER BY
            percentage DESC NULLS LAST,
            pass_rate DESC NULLS LAST,
            passed DESC,
            average DESC NULLS LAST`,
        [testId, sectorId]
    );

    return result.rows.map(row => {
        const total = toNumber(row.total_candidates);
        const recorded = toNumber(row.recorded);

        return {
            id: row.subject_id,
            name: row.subject_name,
            subject_id: row.subject_id,
            average: toNumber(row.average),
            percentage: toNumber(row.percentage),
            pass_rate: toNumber(row.pass_rate),
            passed: toNumber(row.passed),
            failed: toNumber(row.failed),
            total_candidates: total,
            recorded,
            missing: toNumber(row.missing),
            status: calculateStatus(recorded, total)
        };
    });
}

/* =====================================================
   TEACHER PERFORMANCE AND CLASS BREAKDOWN
===================================================== */

async function getTeacherPerformance(
    client,
    testId,
    sectorId
) {
    const result = await client.query(
        `WITH scoped_classes AS (
            SELECT DISTINCT
                tc.school_id,
                tc.class_id
            FROM test_classes tc
            JOIN schools s
                ON s.id = tc.school_id
            WHERE tc.test_id = $1
            AND s.sector_id = $2
        ),

        assignments AS (
            SELECT DISTINCT
                ta.teacher_id,
                ta.school_id,
                ta.class_id,
                ta.subject_id

            FROM teacher_assignments ta

            JOIN scoped_classes sc
                ON sc.school_id = ta.school_id
                AND sc.class_id = ta.class_id

            JOIN users u
                ON u.id = ta.teacher_id
                AND u.role = 'teacher'

            JOIN test_subjects ts
                ON ts.test_id = $1
                AND ts.subject_id = ta.subject_id
        ),

        latest_marks AS (
            SELECT DISTINCT ON (
                m.test_id,
                m.student_id,
                m.class_id,
                m.subject_id
            )
                m.id,
                m.student_id,
                m.class_id,
                m.subject_id,
                m.score

            FROM marks m

            WHERE m.test_id = $1

            ORDER BY
                m.test_id,
                m.student_id,
                m.class_id,
                m.subject_id,
                m.updated_at DESC NULLS LAST,
                m.created_at DESC NULLS LAST,
                m.id DESC
        ),

        candidates AS (
            SELECT
                a.teacher_id,
                u.full_name AS teacher,

                a.school_id,
                s.school_name AS school,

                a.class_id,
                c.class_name,

                a.subject_id,
                sub.subject_name AS subject,

                ts.total_marks,

                st.id AS student_id,

                lm.id AS mark_id,
                lm.score

            FROM assignments a

            JOIN users u
                ON u.id = a.teacher_id

            JOIN schools s
                ON s.id = a.school_id

            JOIN classes c
                ON c.id = a.class_id

            JOIN subjects sub
                ON sub.id = a.subject_id

            JOIN test_subjects ts
                ON ts.test_id = $1
                AND ts.subject_id = a.subject_id

            JOIN students st
                ON st.school_id = a.school_id
                AND st.class_id = a.class_id

            LEFT JOIN latest_marks lm
                ON lm.student_id = st.id
                AND lm.class_id = a.class_id
                AND lm.subject_id = a.subject_id
        )

        SELECT
            teacher_id::text,
            teacher,

            school_id::text,
            school,

            class_id::text,
            class_name,

            subject_id::text,
            subject,

            COUNT(*) AS total_candidates,

            COUNT(mark_id) AS recorded,

            COUNT(*) - COUNT(mark_id) AS missing,

            COUNT(*) FILTER (
                WHERE mark_id IS NOT NULL
                AND score >= total_marks * 0.5
            ) AS passed,

            COUNT(*) FILTER (
                WHERE mark_id IS NOT NULL
                AND score < total_marks * 0.5
            ) AS failed,

            ROUND(
                AVG(score) FILTER (
                    WHERE mark_id IS NOT NULL
                ),
                2
            ) AS average,

            ROUND(
                AVG(
                    score / NULLIF(total_marks, 0) * 100
                ) FILTER (
                    WHERE mark_id IS NOT NULL
                ),
                2
            ) AS percentage

        FROM candidates

        GROUP BY
            teacher_id,
            teacher,
            school_id,
            school,
            class_id,
            class_name,
            subject_id,
            subject

        ORDER BY
            teacher,
            subject,
            class_name`,
        [testId, sectorId]
    );

    /* ---------------------------------------------
       GROUP CLASS BREAKDOWNS BY TEACHER + SUBJECT
    --------------------------------------------- */

    const grouped = new Map();

    for (const row of result.rows) {
        const key = [
            row.teacher_id,
            row.school_id,
            row.subject_id
        ].join("_");

        const total = toNumber(row.total_candidates);
        const recorded = toNumber(row.recorded);

        const breakdown = {
            class_id: row.class_id,
            class_name: row.class_name,
            subject: row.subject,

            total_candidates: total,
            recorded,
            missing: toNumber(row.missing),

            passed: toNumber(row.passed),
            failed: toNumber(row.failed),

            average: toNumber(row.average),
            percentage: toNumber(row.percentage),

            status: calculateStatus(recorded, total)
        };

        if (!grouped.has(key)) {
            grouped.set(key, {
                teacher_id: row.teacher_id,
                teacher: row.teacher,

                school_id: row.school_id,
                school: row.school,

                subject_id: row.subject_id,
                subject: row.subject,

                total_candidates: 0,
                recorded: 0,
                missing: 0,
                passed: 0,
                failed: 0,

                weighted_average: 0,
                weighted_percentage: 0,

                breakdown: []
            });
        }

        const teacher = grouped.get(key);

        teacher.total_candidates += total;
        teacher.recorded += recorded;
        teacher.missing += toNumber(row.missing);
        teacher.passed += toNumber(row.passed);
        teacher.failed += toNumber(row.failed);

        if (recorded > 0) {
            teacher.weighted_average +=
                toNumber(row.average) * recorded;

            teacher.weighted_percentage +=
                toNumber(row.percentage) * recorded;
        }

        teacher.breakdown.push(breakdown);
    }

    return Array.from(grouped.values())
        .map(teacher => {
            const recorded = teacher.recorded;
            const total = teacher.total_candidates;

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

                average: recorded > 0
                    ? round(
                        teacher.weighted_average / recorded
                    )
                    : 0,

                percentage: recorded > 0
                    ? round(
                        teacher.weighted_percentage / recorded
                    )
                    : 0,

                pass_rate: recorded > 0
                    ? round(
                        teacher.passed / recorded * 100
                    )
                    : 0,

                status: calculateStatus(recorded, total),

                breakdown: teacher.breakdown
            };
        })
        .sort((a, b) =>
            b.percentage - a.percentage ||
            b.pass_rate - a.pass_rate ||
            b.passed - a.passed ||
            b.average - a.average
        );
}

/* =====================================================
   GET REQUEST
===================================================== */

export async function onRequestGet(context) {
    const auth = await requireSectorAdmin(context);

    if (auth.error) {
        return auth.error;
    }

    if (!auth.sectorId) {
        return json({
            success: false,
            message: "Your account is not assigned to a sector."
        }, 403);
    }

    let client;

    try {
        client = await connectDB(context);

        const sectorId = auth.sectorId;

        const testId = new URL(
            context.request.url
        ).searchParams.get("test_id");

        /* ---------------------------------------------
           LOAD AVAILABLE TESTS
        --------------------------------------------- */

        const tests = await getSectorTests(
            client,
            sectorId
        );

        /* ---------------------------------------------
           NO TEST SELECTED
        --------------------------------------------- */

        if (!testId) {
            return json({
                success: true,
                user: {
                    role: auth.role,
                    full_name: auth.fullName
                },
                tests
            });
        }

        /* ---------------------------------------------
           VALIDATE TEST ID
        --------------------------------------------- */

        if (!/^[1-9][0-9]*$/.test(testId)) {
            return json({
                success: false,
                message: "Invalid test ID."
            }, 400);
        }

        /* ---------------------------------------------
           VERIFY SECTOR ACCESS
        --------------------------------------------- */

        const allowed = await verifyTest(
            client,
            testId,
            sectorId
        );

        if (!allowed) {
            return json({
                success: false,
                message: "This test does not belong to your sector."
            }, 403);
        }

        /* ---------------------------------------------
           LOAD PERFORMANCE DATA
        --------------------------------------------- */

        const [
            subjects,
            teachers
        ] = await Promise.all([
            getSubjectPerformance(
                client,
                testId,
                sectorId
            ),

            getTeacherPerformance(
                client,
                testId,
                sectorId
            )
        ]);

        /* ---------------------------------------------
           SUMMARY
        --------------------------------------------- */

        const totalTeachers = new Set(
            teachers.map(item => item.teacher_id)
        ).size;

        const completedEntries = teachers.filter(
            item => item.status === "completed"
        ).length;

        const pendingEntries = teachers.filter(
            item => item.status === "pending"
        ).length;

        const allRecorded = teachers.reduce(
            (sum, item) => sum + item.recorded,
            0
        );

        const weightedPercentage = teachers.reduce(
            (sum, item) =>
                sum + item.percentage * item.recorded,
            0
        );

        const sectorAverage = allRecorded > 0
            ? round(weightedPercentage / allRecorded)
            : 0;

        return json({
            success: true,

            user: {
                role: auth.role,
                full_name: auth.fullName
            },

            tests,

            summary: {
                total_teachers: totalTeachers,
                completed_entries: completedEntries,
                pending_entries: pendingEntries,
                sector_average: sectorAverage
            },

            subjects,
            teachers
        });

    } catch (error) {
        console.error(
            "Sector teachers performance error:",
            error
        );

        return json({
            success: false,
            message: "Unable to load sector performance."
        }, 500);

    } finally {
        if (client) {
            await client.end().catch(() => {});
        }
    }
}
