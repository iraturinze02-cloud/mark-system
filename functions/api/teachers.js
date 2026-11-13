
import bcrypt from "bcryptjs";
import {
    connectDB,
    requireSchoolAdmin,
    json
} from "../_utils.js";

export async function onRequestGet(context) {
    const auth = await requireSchoolAdmin(context);
    if (auth.error) return auth.error;

    let client;

    try {
        client = await connectDB(context);

        const result = await client.query(
            `SELECT
                t.id,
                t.user_id,
                t.staff_number,
                u.full_name,
                u.phone,
                u.status,
                COALESCE(
                    (
                        SELECT json_agg(
                            json_build_object(
                                'assignment_id', ta.id,
                                'class_id', c.id,
                                'class_name', c.class_name,
                                'subject_id', s.id,
                                'subject_name', s.subject_name
                            )
                            ORDER BY c.class_name, s.subject_name
                        )
                        FROM teacher_assignments ta
                        JOIN classes c
                          ON c.id = ta.class_id
                         AND c.school_id = ta.school_id
                        JOIN subjects s
                          ON s.id = ta.subject_id
                        WHERE ta.teacher_id = t.id
                          AND ta.school_id = $1
                    ),
                    '[]'::json
                ) AS assignments
             FROM teachers t
             JOIN users u ON u.id = t.user_id
             WHERE t.school_id = $1
               AND u.role = 'teacher'
             ORDER BY u.full_name ASC`,
            [auth.schoolId]
        );

        return json({
            success: true,
            teachers: result.rows
        });

    } catch (error) {
        console.error("Load teachers error:", error);

        return json({
            success: false,
            message: "Failed to load teachers."
        }, 500);

    } finally {
        if (client) await client.end().catch(() => {});
    }
}

export async function onRequestPost(context) {
    const auth = await requireSchoolAdmin(context);
    if (auth.error) return auth.error;

    let data;

    try {
        data = await context.request.json();
    } catch {
        return json({
            success: false,
            message: "Invalid JSON request."
        }, 400);
    }

    const fullName = String(data.full_name || "").trim();
    const phone = String(data.phone || "").trim();
    const password = String(data.password || "");
    const staffNumber = String(data.staff_number || "").trim() || null;

    if (!fullName || !phone || !password) {
        return json({
            success: false,
            message: "Full name, phone number and password are required."
        }, 400);
    }

    if (
        fullName.length > 200 ||
        phone.length > 30 ||
        (staffNumber && staffNumber.length > 50)
    ) {
        return json({
            success: false,
            message: "One or more fields exceed the allowed length."
        }, 400);
    }

    if (password.length < 8) {
        return json({
            success: false,
            message: "Password must contain at least 8 characters."
        }, 400);
    }

    let client;
    let transactionStarted = false;

    try {
        client = await connectDB(context);

        await client.query("BEGIN");
        transactionStarted = true;

        const duplicate = await client.query(
            `SELECT id FROM users WHERE phone = $1 LIMIT 1`,
            [phone]
        );

        if (duplicate.rowCount > 0) {
            await client.query("ROLLBACK");
            transactionStarted = false;

            return json({
                success: false,
                message: "This phone number is already registered."
            }, 409);
        }

        const passwordHash = await bcrypt.hash(password, 12);

        const userResult = await client.query(
            `INSERT INTO users (
                full_name,
                phone,
                password_hash,
                role,
                school_id,
                status
            )
            VALUES ($1, $2, $3, 'teacher', $4, 'active')
            RETURNING id, full_name, phone`,
            [fullName, phone, passwordHash, auth.schoolId]
        );

        const user = userResult.rows[0];

        const teacherResult = await client.query(
            `INSERT INTO teachers (
                user_id,
                school_id,
                staff_number
            )
            VALUES ($1, $2, $3)
            RETURNING id, user_id, staff_number`,
            [user.id, auth.schoolId, staffNumber]
        );

        await client.query("COMMIT");
        transactionStarted = false;

        return json({
            success: true,
            message: "Teacher created successfully.",
            teacher: {
                ...teacherResult.rows[0],
                full_name: user.full_name,
                phone: user.phone,
                assignments: []
            }
        }, 201);

    } catch (error) {
        if (client && transactionStarted) {
            await client.query("ROLLBACK").catch(() => {});
        }

        console.error("Create teacher error:", error);

        if (error.code === "23505") {
            return json({
                success: false,
                message: "The phone number or staff number is already registered."
            }, 409);
        }

        return json({
            success: false,
            message: "Failed to create teacher."
        }, 500);

    } finally {
        if (client) await client.end().catch(() => {});
    }
}
