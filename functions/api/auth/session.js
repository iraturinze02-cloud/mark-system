import {
    connectDB,
    json,
    authenticateRole
} from "../../_utils.js";

export async function onRequestGet(context) {
    const auth = await authenticateRole(context, [
        "owner",
        "sector_admin",
        "school_admin",
        "teacher"
    ]);

    if (auth.error) {
        return auth.error;
    }

    return json({
        success: true,
        user: {
            id: auth.user.id,
            fullName: auth.user.full_name,
            phone: auth.user.phone,
            email: auth.user.email,
            role: auth.user.role,
            sectorId: auth.user.sector_id,
            schoolId: auth.user.school_id
        }
    });
}
