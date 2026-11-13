
import bcrypt from "bcryptjs";
import {
    connectDB,
    requireSchoolAdmin,
    json
} from "../../_utils.js";

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

    const teacherId = String(data.id || "").trim();
    const fullName = String(data.full_name || "").trim();
    const phone = String(data.phone || "").trim();
    const password = String(data.password || "");
    const staffNumber = String(data.staff_number || "").trim() || null;

    if (!/^[1-9]\d*$/.test(teacherId)) {
        return json({
            success: false,
            message: "Invalid teacher ID."
        }, 400);
    }

    if (!fullName || !phone) {
        return json({
            success: false,
            message: "Full name and phone number are required."
        }, 400);
    }

    if (fullName.length > 200 || phone.length > 30 ||
        (staffNumber && staffNumber.length > 50)) {
        return json({
            success: false,
            message: "One or more fields exceed the allowed length."
        }, 400);
    }

    if (password && password.length < 8) {
        return json({
            success: false,
            message: "New password must contain at least 8 characters."
        }, 400);
    }

    let client;
    let transactionStarted = false;

    try {
        client = await connectDB(context);
        await client.query("BEGIN");
        transactionStarted = true;

        // Confirm the teacher belongs to this school.
        const teacherResult = await client.query(
            `SELECT t.id, t.user_id
             FROM teachers t
             JOIN users u ON u.id = t.user_id
             WHERE t.id = $1
               AND t.school_id = $2
               AND u.school_id = $2
               AND u.role = 'teacher'
             FOR UPDATE OF t, u`,
            [teacherId, auth.schoolId]
        );

        if (teacherResult.rowCount === 0) {
            await client.query("ROLLBACK");
            transactionStarted = false;

            return json({
                success: false,
                message: "Teacher not found in your school."
            }, 404);
        }

        const userId = teacherResult.rows[0].user_id;

        const duplicate = await client.query(
            `SELECT id
             FROM users
             WHERE phone = $1
               AND id <> $2
             LIMIT 1`,
            [phone, userId]
        );

        if (duplicate.rowCount > 0) {
            await client.query("ROLLBACK");
            transactionStarted = false;

            return json({
                success: false,
                message: "This phone number is already registered."
            }, 409);
        }

        let userResult;

        if (password) {
            const passwordHash = await bcrypt.hash(password, 12);

            userResult = await client.query(
                `UPDATE users
                 SET full_name = $1,
                     phone = $2,
                     password_hash = $3,
                     updated_at = NOW()
                 WHERE id = $4
                   AND school_id = $5
                   AND role = 'teacher'
                 RETURNING id, full_name, phone`,
                [fullName, phone, passwordHash, userId, auth.schoolId]
            );
        } else {
            userResult = await client.query(
                `UPDATE users
                 SET full_name = $1,
                     phone = $2,
                     updated_at = NOW()
                 WHERE id = $3
                   AND school_id = $4
                   AND role = 'teacher'
                 RETURNING id, full_name, phone`,
                [fullName, phone, userId, auth.schoolId]
            );
        }

        await client.query(
            `UPDATE teachers
             SET staff_number = $1
             WHERE id = $2
               AND school_id = $3`,
            [staffNumber, teacherId, auth.schoolId]
        );

        await client.query("COMMIT");
        transactionStarted = false;

        return json({
            success: true,
            message: "Teacher updated successfully.",
            teacher: {
                id: teacherId,
                user_id: userId,
                full_name: userResult.rows[0].full_name,
                phone: userResult.rows[0].phone,
                staff_number: staffNumber
            }
        });

    } catch (error) {
        if (client && transactionStarted) {
            await client.query("ROLLBACK").catch(() => {});
        }

        console.error("Update teacher error:", error);

        if (error.code === "23505") {
            return json({
                success: false,
                message: "The phone number or staff number is already registered."
            }, 409);
        }

        return json({
            success: false,
            message: "Failed to update teacher."
        }, 500);

    } finally {
        if (client) await client.end().catch(() => {});
    }
}
