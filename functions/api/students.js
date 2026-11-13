
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
                st.id,
                st.student_code,
                st.full_name,
                st.gender,
                st.date_of_birth,
                st.admission_date,
                st.status,
                st.class_id,
                c.class_name,
                c.class_level
             FROM students st
             JOIN classes c
               ON c.id = st.class_id
              AND c.school_id = st.school_id
             WHERE st.school_id = $1
             ORDER BY c.class_name ASC, st.full_name ASC`,
            [auth.schoolId]
        );

        return json({
            success: true,
            students: result.rows
        });

    } catch (error) {
        console.error("Get students error:", error);

        return json({
            success: false,
            message: "Failed to load students."
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
            message: "Invalid request data."
        }, 400);
    }

    const classId = Number(data.class_id);
    const fullName = String(data.full_name || "").trim();
    const gender = data.gender
        ? String(data.gender).trim()
        : null;
    const dateOfBirth = data.date_of_birth || null;
    const admissionDate = data.admission_date || null;

    if (!Number.isSafeInteger(classId) || classId <= 0 || !fullName) {
        return json({
            success: false,
            message: "Please provide a valid class and student name."
        }, 400);
    }

    if (fullName.length > 200) {
        return json({
            success: false,
            message: "Student name must not exceed 200 characters."
        }, 400);
    }

    if (gender && gender.length > 20) {
        return json({
            success: false,
            message: "Invalid gender value."
        }, 400);
    }

    const studentCode =
        `STU-${Date.now()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

    let client;

    try {
        client = await connectDB(context);

        const classResult = await client.query(
            `SELECT id
             FROM classes
             WHERE id = $1 AND school_id = $2`,
            [classId, auth.schoolId]
        );

        if (classResult.rowCount === 0) {
            return json({
                success: false,
                message: "The selected class does not belong to your school."
            }, 403);
        }

        const result = await client.query(
            `INSERT INTO students (
                school_id,
                class_id,
                student_code,
                full_name,
                gender,
                date_of_birth,
                admission_date
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING id, student_code, full_name, class_id, gender,
                       date_of_birth, admission_date, status`,
            [
                auth.schoolId,
                classId,
                studentCode,
                fullName,
                gender,
                dateOfBirth,
                admissionDate
            ]
        );

        return json({
            success: true,
            message: "Student registered successfully.",
            student: result.rows[0]
        }, 201);

    } catch (error) {
        console.error("Create student error:", error);

        return json({
            success: false,
            message: "Failed to register student."
        }, 500);

    } finally {
        if (client) await client.end().catch(() => {});
    }
}
