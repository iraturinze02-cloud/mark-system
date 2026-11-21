import {
    json,
    authenticateRole
} from "../../_utils.js";

export async function onRequestGet(context) {
    const auth = await authenticateRole(context, [
        "owner",
        "sector_admin",
        "school_admin",
        "dos",
        "teacher"
    ]);

    if (auth.error) {
        return auth.error;
    }

    return json({
        success: true,
        user: {
            id: auth.userId,
            fullName: auth.fullName,
            phone: auth.phone,
            email: auth.email,
            emailVerified: auth.emailVerified,
            role: auth.role,
            sectorId: auth.sectorId,
            schoolId: auth.schoolId
        }
    });
}
