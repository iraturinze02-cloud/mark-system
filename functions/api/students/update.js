
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
            message: "Invalid request data."
        }, 400);
    }

    const studentId = Number(data.id);
    const classId = Number(data.class_id);
    const fullName = String(data.full_name || "").trim();
    const gender = data.gender
        ? String(data.gender).trim()
        : null;
    const dateOfBirth = data.date_of_birth || null;
    const admissionDate = data.admission_date || null;

    if (
        !Number.isSafeInteger(studentId) || studentId <= 0 ||
        !Number.isSafeInteger(classId) || classId <= 0 ||
        !fullName
    ) {
        return json({
            success: false,
            message: "Please provide valid student details."
        }, 400);
    }

    if (fullName.length > 200) {
        return json({
            success: false,
            message: "Student name must not exceed 200 characters."
        }, 400);
    }

    let client;

    try {
        client = await connectDB(context);

        const result = await client.query(
            `UPDATE students st
             SET
                class_id = $1,
                full_name = $2,
                gender = $3,
                date_of_birth = $4,
                admission_date = $5
             WHERE st.id = $6
               AND st.school_id = $7
               AND EXISTS (
                   SELECT 1
                   FROM classes c
                   WHERE c.id = $1
                     AND c.school_id = $7
               )
             RETURNING
                st.id,
                st.student_code,
                st.full_name,
                st.class_id,
                st.gender,
                st.date_of_birth,
                st.admission_date,
                st.status`,
            [
                classId,
                fullName,
                gender,
                dateOfBirth,
                admissionDate,
                studentId,
                auth.schoolId
            ]
        );

        if (result.rowCount === 0) {
            return json({
                success: false,
                message: "Student or selected class was not found in your school."
            }, 404);
        }

        return json({
            success: true,
            message: "Student updated successfully.",
            student: result.rows[0]
        });

    } catch (error) {
        console.error("Update student error:", error);

        return json({
            success: false,
            message: "Failed to update student."
        }, 500);

    } finally {
        if (client) await client.end().catch(() => {});
    }
}
