
import {
    connectDB,
    requireTestUser,
    json
} from "../_utils.js";

export async function onRequestGet(context) {
    const auth = await requireTestUser(context);
    if (auth.error) return auth.error;

    if (!["sector_admin", "school_admin"].includes(auth.role)) {
        return json({ success: false, message: "Not authorized." }, 403);
    }

    let client;

    try {
        client = await connectDB(context);

        let schools = [];

        if (auth.role === "sector_admin") {
            const result = await client.query(`
                SELECT id, school_name
                FROM schools
                WHERE sector_id = $1 AND status = 'active'
                ORDER BY school_name
            `, [auth.sectorId]);

            schools = result.rows;
        } else {
            const result = await client.query(`
                SELECT id, school_name
                FROM schools
                WHERE id = $1 AND status = 'active'
            `, [auth.schoolId]);

            schools = result.rows;
        }

        const schoolIds = schools.map(s => String(s.id));

        const classesResult = await client.query(`
            SELECT id, school_id, class_name, class_level
            FROM classes
            WHERE school_id = ANY($1::bigint[])
            ORDER BY school_id, class_name
        `, [schoolIds]);

        const subjectsResult = await client.query(`
            SELECT id, subject_name, subject_code
            FROM subjects
            ORDER BY subject_name
        `);

        return json({
            success: true,
            schools,
            classes: classesResult.rows,
            subjects: subjectsResult.rows
        });

    } catch (error) {
        console.error("Test options error:", error);
        return json({
            success: false,
            message: "Unable to load test options."
        }, 500);
    } finally {
        if (client) await client.end().catch(() => {});
    }
}
