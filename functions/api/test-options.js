
import {
    connectDB,
    requireTestUser,
    json
} from "../_utils.js";

export async function onRequest(context) {
    const auth = await requireTestUser(context);

    if (auth.error) {
        return auth.error;
    }

    if (context.request.method !== "GET") {
        return json({
            success: false,
            message: "Method not allowed."
        }, 405);
    }

    if (![
        "sector_admin",
        "school_admin",
        "dos",
        "teacher"
    ].includes(auth.role)) {
        return json({
            success: false,
            message: "You are not allowed to access test creation options."
        }, 403);
    }

    let client;

    try {
        client = await connectDB(context);

        let schools = [];

        /* =====================================================
           1. LOAD AUTHORIZED SCHOOLS

           Sector admin:
           - All active schools in their sector.

           School admin / DOS:
           - Their own active school.

           Teacher:
           - Only schools where they have teacher assignments.
           - School access is derived from teacher_assignments.
        ===================================================== */

        if (auth.role === "sector_admin") {
            const result = await client.query(`
                SELECT
                    id,
                    school_name
                FROM schools
                WHERE sector_id = $1
                  AND status = 'active'
                ORDER BY school_name
            `, [auth.sectorId]);

            schools = result.rows;

        } else if (auth.role === "teacher") {
            const result = await client.query(`
                SELECT DISTINCT
                    s.id,
                    s.school_name
                FROM teachers tr

                INNER JOIN teacher_assignments ta
                    ON ta.teacher_id = tr.id

                INNER JOIN schools s
                    ON s.id = ta.school_id

                WHERE tr.user_id = $1
                  AND s.status = 'active'

                ORDER BY s.school_name
            `, [auth.userId]);

            schools = result.rows;

        } else {
            const result = await client.query(`
                SELECT
                    id,
                    school_name
                FROM schools
                WHERE id = $1
                  AND status = 'active'
            `, [auth.schoolId]);

            schools = result.rows;
        }

        const schoolIds = schools.map(
            school => String(school.id)
        );

        /* =====================================================
           2. HANDLE USERS WITHOUT AUTHORIZED SCHOOLS
        ===================================================== */

        if (!schoolIds.length) {
            return json({
                success: true,
                schools: [],
                classes: [],
                subjects: [],
                academic_periods: []
            });
        }

        /* =====================================================
           3. LOAD ACTIVE ACADEMIC YEAR AND TERM
           FOR EACH AUTHORIZED SCHOOL
        ===================================================== */

        const academicPeriodResult = await client.query(`
            SELECT
                ay.school_id,
                ay.id AS academic_year_id,
                ay.year_name,
                ay.start_date AS academic_year_start,
                ay.end_date AS academic_year_end,

                t.id AS term_id,
                t.term_number,
                t.term_name,
                t.start_date AS term_start,
                t.end_date AS term_end

            FROM academic_years ay

            INNER JOIN terms t
                ON t.academic_year_id = ay.id
               AND t.school_id = ay.school_id

            WHERE ay.school_id = ANY($1::bigint[])

              AND (NOW() AT TIME ZONE 'Africa/Kigali')::date
                  BETWEEN ay.start_date AND ay.end_date

              AND (NOW() AT TIME ZONE 'Africa/Kigali')::date
                  BETWEEN t.start_date AND t.end_date

            ORDER BY ay.school_id
        `, [schoolIds]);

        /* =====================================================
           4. ENSURE EACH SCHOOL HAS EXACTLY ONE
              ACTIVE ACADEMIC YEAR AND TERM
        ===================================================== */

        const periodsBySchool = new Map();

        for (const period of academicPeriodResult.rows) {
            const schoolId = String(period.school_id);

            if (!periodsBySchool.has(schoolId)) {
                periodsBySchool.set(schoolId, []);
            }

            periodsBySchool.get(schoolId).push(period);
        }

        const academicPeriods = [];
        const schoolsWithoutValidPeriod = [];

        for (const school of schools) {
            const periods =
                periodsBySchool.get(String(school.id)) || [];

            if (periods.length !== 1) {
                schoolsWithoutValidPeriod.push({
                    school_id: school.id,
                    school_name: school.school_name,
                    matching_periods: periods.length
                });

                continue;
            }

            academicPeriods.push({
                school_id: school.id,
                school_name: school.school_name,
                ...periods[0]
            });
        }

        if (schoolsWithoutValidPeriod.length) {
            return json({
                success: false,
                message:
                    "Every selected school must have exactly one active academic year and term before creating a test.",
                schools: schoolsWithoutValidPeriod
            }, 409);
        }

        /* =====================================================
           5. LOAD CLASSES

           Teacher:
           - Only classes in their teacher_assignments.
           - school_ids contains only schools where they have
             the corresponding class assignment.

           Administrators:
           - Preserve the existing school-level class loading.
        ===================================================== */

        let classResult;

        if (auth.role === "teacher") {
            classResult = await client.query(`
                SELECT
                    c.id,
                    c.class_name,

                    CASE c.level_id
                        WHEN 1 THEN 'Primary'
                        WHEN 2 THEN 'Lower Secondary'
                        WHEN 3 THEN 'Upper Secondary'
                        ELSE 'Unknown'
                    END AS class_level,

                    c.level_id,

                    ARRAY_AGG(
                        DISTINCT ta.school_id
                        ORDER BY ta.school_id
                    ) AS school_ids

                FROM teachers tr

                INNER JOIN teacher_assignments ta
                    ON ta.teacher_id = tr.id

                INNER JOIN classes c
                    ON c.id = ta.class_id

                INNER JOIN schools s
                    ON s.id = ta.school_id

                WHERE tr.user_id = $1
                  AND ta.school_id = ANY($2::bigint[])
                  AND s.status = 'active'

                GROUP BY
                    c.id,
                    c.class_name,
                    c.level_id

                ORDER BY
                    c.level_id,
                    c.class_name
            `, [auth.userId, schoolIds]);

        } else {
            classResult = await client.query(`
                SELECT
                    c.id,
                    c.class_name,

                    CASE c.level_id
                        WHEN 1 THEN 'Primary'
                        WHEN 2 THEN 'Lower Secondary'
                        WHEN 3 THEN 'Upper Secondary'
                        ELSE 'Unknown'
                    END AS class_level,

                    c.level_id,

                    ARRAY_AGG(
                        DISTINCT sl.school_id
                        ORDER BY sl.school_id
                    ) AS school_ids

                FROM classes c

                INNER JOIN school_levels sl
                    ON sl.level_id = c.level_id

                INNER JOIN schools s
                    ON s.id = sl.school_id

                WHERE sl.school_id = ANY($1::bigint[])
                  AND s.status = 'active'

                GROUP BY
                    c.id,
                    c.class_name,
                    c.level_id

                ORDER BY
                    c.level_id,
                    c.class_name
            `, [schoolIds]);
        }

        /* =====================================================
           6. LOAD SUBJECTS

           Teacher:
           - Only subjects in their teacher_assignments.
           - Retain education_levels for the existing
             class/subject compatibility filtering in the UI.

           Administrators:
           - Preserve the existing subject options.
        ===================================================== */

        let subjectResult;

        if (auth.role === "teacher") {
            subjectResult = await client.query(`
                SELECT
                    s.id,
                    s.subject_name,

                    ARRAY_AGG(
                        DISTINCT scl.education_level
                        ORDER BY scl.education_level
                    ) AS education_levels

                FROM teachers tr

                INNER JOIN teacher_assignments ta
                    ON ta.teacher_id = tr.id

                INNER JOIN subjects s
                    ON s.id = ta.subject_id

                INNER JOIN subject_class_levels scl
                    ON scl.subject_id = s.id

                WHERE tr.user_id = $1
                  AND ta.school_id = ANY($2::bigint[])

                GROUP BY
                    s.id,
                    s.subject_name

                ORDER BY
                    s.subject_name
            `, [auth.userId, schoolIds]);

        } else {
            subjectResult = await client.query(`
                SELECT
                    s.id,
                    s.subject_name,

                    ARRAY_AGG(
                        DISTINCT scl.education_level
                        ORDER BY scl.education_level
                    ) AS education_levels

                FROM subjects s

                INNER JOIN subject_class_levels scl
                    ON scl.subject_id = s.id

                GROUP BY
                    s.id,
                    s.subject_name

                ORDER BY
                    s.subject_name
            `);
        }

        /* =====================================================
           7. RETURN TEST CREATION OPTIONS
        ===================================================== */

        return json({
            success: true,
            schools,
            classes: classResult.rows,
            subjects: subjectResult.rows,
            academic_periods: academicPeriods
        });

    } catch (error) {
        console.error("Test options API error:", error);

        return json({
            success: false,
            message: error.message ||
                "Unable to load test creation options."
        }, 500);

    } finally {
        if (client) {
            await client.end().catch(() => {});
        }
    }
}
