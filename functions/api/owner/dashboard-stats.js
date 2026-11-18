import {
    connectDB,
    json,
    requireOwner
} from "../../_utils.js";

export async function onRequestGet(context) {
    const auth = await requireOwner(context);

    if (auth.error) {
        return auth.error;
    }

    let client;

    try {
        client = await connectDB(context);

        const result = await client.query(`
            SELECT
                (SELECT COUNT(*) FROM sectors) AS sectors,
                (SELECT COUNT(*) FROM schools) AS schools,
                (SELECT COUNT(*) FROM users) AS users,
                (SELECT COUNT(*) FROM examinations) AS examinations,
                (SELECT COUNT(*) FROM students) AS students,
                (SELECT COUNT(*) FROM teachers) AS teachers,
                (SELECT COUNT(*) FROM tests) AS tests
        `);

        const stats = result.rows[0];

        return json({
            success: true,
            statistics: {
                sectors: Number(stats.sectors),
                schools: Number(stats.schools),
                users: Number(stats.users),
                examinations: Number(stats.examinations),
                students: Number(stats.students),
                teachers: Number(stats.teachers),
                tests: Number(stats.tests)
            }
        });

    } catch (error) {
        console.error("Owner dashboard statistics error:", error);

        return json({
            success: false,
            message: "Unable to load dashboard statistics."
        }, 500);

    } finally {
        if (client) {
            await client.end().catch(() => {});
        }
    }
}
