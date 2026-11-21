
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

    if (!["sector_admin","dos", "school_admin"].includes(auth.role)) {
        return json({
            success: false,
            message: "You are not allowed to access test creation options."
        }, 403);
    }

    let client;

    try {
        client = await connectDB(context);

        let schools = [];

        // =========================================
        // LOAD AUTHORIZED SCHOOLS
        // =========================================

        if (auth.role === "sector_admin") {
            const result = await client.query(`
                SELECT id, school_name
                FROM schools
                WHERE sector_id = $1
                  AND status = 'active'
                ORDER BY school_name
            `, [auth.sectorId]);

            schools = result.rows;

        } else {
            const result = await client.query(`
                SELECT id, school_name
                FROM schools
                WHERE id = $1
                  AND status = 'active'
            `, [auth.schoolId]);

            schools = result.rows;
        }

        const schoolIds = schools.map(school => String(school.id));

        if (!schoolIds.length) {
            return json({
                success: true,
                schools: [],
                classes: [],
                subjects: []
            });
        }

        // =========================================
        // LOAD UNIVERSAL CLASSES
        // Each class appears only once.
        // school_ids identifies schools offering it.
        // =========================================

        const classResult = await client.query(`
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

        // =========================================
        // LOAD ONLY SUBJECTS WITH THEIR APPLICABLE
        // EDUCATION LEVELS
        // =========================================

        const subjectResult = await client.query(`
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

        return json({
            success: true,
            schools,
            classes: classResult.rows,
            subjects: subjectResult.rows
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
