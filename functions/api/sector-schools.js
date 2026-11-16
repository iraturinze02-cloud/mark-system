
import {
    connectDB,
    requireSectorAdmin,
    json
} from "../_utils.js";

export async function onRequestGet(context) {
    const auth = await requireSectorAdmin(context);

    if (auth.error) return auth.error;

    let client;

    try {
        client = await connectDB(context);

        const result = await client.query(
            `SELECT
                s.id,
                s.school_name,
                s.school_code,
                s.school_type,
                s.location,
                s.status,

                /* SCHOOL ADMINISTRATORS */
                COALESCE(
                    (
                        SELECT json_agg(
                            json_build_object(
                                'id', u.id,
                                'full_name', u.full_name,
                                'phone', u.phone,
                                'status', u.status
                            )
                            ORDER BY u.full_name
                        )
                        FROM users u
                        WHERE u.school_id = s.id
                          AND u.role = 'school_admin'
                    ),
                    '[]'::json
                ) AS admins,

                /* TEACHERS AND ASSIGNMENTS */
                COALESCE(
                    (
                        SELECT json_agg(
                            json_build_object(
                                'id', t.id,
                                'user_id', t.user_id,
                                'staff_number', t.staff_number,
                                'full_name', tu.full_name,
                                'phone', tu.phone,
                                'status', tu.status,

                                'assignments',
                                COALESCE(
                                    (
                                        SELECT json_agg(
                                            json_build_object(
                                                'assignment_id', ta.id,
                                                'class_id', c.id,
                                                'class_name', c.class_name,
                                                'subject_id', sub.id,
                                                'subject', sub.subject_name
                                            )
                                            ORDER BY
                                                c.class_name,
                                                sub.subject_name
                                        )
                                        FROM teacher_assignments ta

                                        INNER JOIN classes c
                                            ON c.id = ta.class_id

                                        INNER JOIN school_levels sl
                                            ON sl.school_id = ta.school_id
                                           AND sl.level_id = c.level_id

                                        INNER JOIN subjects sub
                                            ON sub.id = ta.subject_id

                                        WHERE ta.teacher_id = t.id
                                          AND ta.school_id = s.id
                                    ),
                                    '[]'::json
                                )
                            )
                            ORDER BY tu.full_name
                        )
                        FROM teachers t

                        INNER JOIN users tu
                            ON tu.id = t.user_id

                        WHERE t.school_id = s.id
                          AND tu.school_id = s.id
                          AND tu.role = 'teacher'
                    ),
                    '[]'::json
                ) AS teachers

             FROM schools s

             WHERE s.sector_id = $1

             ORDER BY s.school_name ASC`,
            [auth.sectorId]
        );

        return json({
            success: true,
            schools: result.rows
        });

    } catch (error) {
        console.error("Load sector schools error:", error);

        return json({
            success: false,
            message: "Failed to load schools, administrators and teachers."
        }, 500);

    } finally {
        if (client) {
            await client.end().catch(() => {});
        }
    }
}
