import { connectDB, requireSectorAdmin, json } from "../_utils.js";

export async function onRequestGet(context) {
    const auth = await requireSectorAdmin(context);

    if (auth.error) {
        return auth.error;
    }

    let client;

    try {
        client = await connectDB(context);

        const result = await client.query(
            `SELECT
                u.id,
                u.full_name,
                u.phone,
                u.school_id,
                u.status,
                s.school_name,

                COALESCE(
                    (
                        SELECT json_agg(
                            json_build_object(
                                'id', el.id::text,
                                'level_name', el.level_name
                            )
                            ORDER BY el.id
                        )
                        FROM school_levels sl
                        INNER JOIN education_levels el
                            ON el.id = sl.level_id
                        WHERE sl.school_id = u.school_id
                    ),
                    '[]'::json
                ) AS levels

             FROM users u

             INNER JOIN schools s
                ON s.id = u.school_id

             WHERE
                u.role = 'school_admin'
                AND s.sector_id = $1

             ORDER BY
                s.school_name ASC,
                u.full_name ASC`,
            [auth.sectorId]
        );

        return json({
            success: true,
            admins: result.rows
        });

    } catch (error) {
        console.error("Load school administrators error:", error);

        return json({
            success: false,
            message: "Failed to load school administrators."
        }, 500);

    } finally {
        if (client) {
            await client.end().catch(() => {});
        }
    }
}
