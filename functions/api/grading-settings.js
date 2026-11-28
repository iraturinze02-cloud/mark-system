
import {
    connectDB,
    authenticateRole,
    json
} from "../_utils.js";

/* =====================================================
   HELPERS
===================================================== */

function validId(value) {
    return /^[1-9]\d*$/.test(String(value || ""));
}

function validMaximum(value) {
    const number = Number(value);

    return Number.isFinite(number) && number > 0;
}

function getScope(source, body = {}) {
    return {
        teacher_id: String(
            body.teacher_id ??
            source.searchParams.get("teacher_id") ??
            ""
        ),

        class_id: String(
            body.class_id ??
            source.searchParams.get("class_id") ??
            ""
        ),

        subject_id: String(
            body.subject_id ??
            source.searchParams.get("subject_id") ??
            ""
        ),

        academic_year_id: String(
            body.academic_year_id ??
            source.searchParams.get("academic_year_id") ??
            ""
        ),

        term_id: String(
            body.term_id ??
            source.searchParams.get("term_id") ??
            ""
        )
    };
}

function validateScope(scope) {
    for (const [key, value] of Object.entries(scope)) {
        if (!validId(value)) {
            return (
                "Invalid or missing " +
                key.replaceAll("_", " ") +
                "."
            );
        }
    }

    return null;
}

/* =====================================================
   AUTHENTICATE TEACHER AND VERIFY ASSIGNMENT
===================================================== */

async function verifyTeacherScope(db, user, scope) {

    if (!user.schoolId) {
        return {
            error: "Your account is not linked to a school."
        };
    }

    /*
       Find the teacher record belonging to the
       authenticated user.
    */

    const teacherResult = await db.query(
        `SELECT
            id,
            user_id,
            school_id
         FROM teachers
         WHERE user_id = $1
           AND school_id = $2
         LIMIT 1`,
        [
            user.userId,
            user.schoolId
        ]
    );

    if (teacherResult.rows.length === 0) {
        return {
            error: "Your teacher profile could not be found."
        };
    }

    const teacher = teacherResult.rows[0];

    /*
       The frontend may send either the teacher profile ID
       or the login user ID as teacher_id.

       The database always stores teachers.id.
    */

    if (
        String(scope.teacher_id) !== String(teacher.id) &&
        String(scope.teacher_id) !== String(user.userId)
    ) {
        return {
            error: "Invalid teacher selection."
        };
    }

    /*
       Confirm that the authenticated teacher is assigned
       to this class and subject in this school.
    */

    const assignmentResult = await db.query(
        `SELECT id
         FROM teacher_assignments
         WHERE teacher_id = $1
           AND school_id = $2
           AND class_id = $3
           AND subject_id = $4
         LIMIT 1`,
        [
            teacher.id,
            user.schoolId,
            scope.class_id,
            scope.subject_id
        ]
    );

    if (assignmentResult.rows.length === 0) {
        return {
            error: "You are not assigned to this class and subject."
        };
    }

    /*
       Confirm that the academic year belongs to the
       authenticated teacher's school.
    */

    const yearResult = await db.query(
        `SELECT id
         FROM academic_years
         WHERE id = $1
           AND school_id = $2
         LIMIT 1`,
        [
            scope.academic_year_id,
            user.schoolId
        ]
    );

    if (yearResult.rows.length === 0) {
        return {
            error: "The selected academic year does not belong to your school."
        };
    }

    /*
       Confirm that the selected term belongs to both
       the selected academic year and the same school.
    */

    const termResult = await db.query(
        `SELECT id
         FROM terms
         WHERE id = $1
           AND academic_year_id = $2
           AND school_id = $3
         LIMIT 1`,
        [
            scope.term_id,
            scope.academic_year_id,
            user.schoolId
        ]
    );

    if (termResult.rows.length === 0) {
        return {
            error: "The selected term does not belong to this academic year."
        };
    }

    return {
        teacherId: String(teacher.id),
        schoolId: String(user.schoolId)
    };
}

/* =====================================================
   GET GRADING SETTINGS
===================================================== */

export async function onRequestGet(context) {
    let db;

    try {

        /* AUTHENTICATION */

        const auth = await authenticateRole(
            context,
            "teacher"
        );

        if (auth.error) {
            return auth.error;
        }

        const url = new URL(context.request.url);

        const scope = getScope(url);

        const validationError = validateScope(scope);

        if (validationError) {
            return json({
                success: false,
                message: validationError
            }, 400);
        }

        db = await connectDB(context);

        /* VERIFY TEACHER OWNERSHIP */

        const verified = await verifyTeacherScope(
            db,
            auth,
            scope
        );

        if (verified.error) {
            return json({
                success: false,
                message: verified.error
            }, 403);
        }

        /* LOAD SETTINGS */

        const result = await db.query(
            `SELECT
                id,
                overall_test_max,
                overall_exam_max,
                created_at,
                updated_at
             FROM grading_settings
             WHERE teacher_id = $1
               AND school_id = $2
               AND class_id = $3
               AND subject_id = $4
               AND academic_year_id = $5
               AND term_id = $6
             LIMIT 1`,
            [
                verified.teacherId,
                verified.schoolId,
                scope.class_id,
                scope.subject_id,
                scope.academic_year_id,
                scope.term_id
            ]
        );

        const settings = result.rows.length
            ? result.rows[0]
            : {
                overall_test_max: 90,
                overall_exam_max: 90
            };

        return json({
            success: true,
            settings
        });

    } catch (error) {

        console.error(
            "GET GRADING SETTINGS ERROR:",
            error
        );

        return json({
            success: false,
            message: "Unable to load grading settings."
        }, 500);

    } finally {

        if (db) {
            await db.end().catch(() => {});
        }
    }
}

/* =====================================================
   SAVE GRADING SETTINGS
===================================================== */

export async function onRequestPost(context) {
    let db;

    try {

        /* AUTHENTICATION */

        const auth = await authenticateRole(
            context,
            "teacher"
        );

        if (auth.error) {
            return auth.error;
        }

        /* READ REQUEST BODY */

        let body;

        try {
            body = await context.request.json();
        } catch {
            return json({
                success: false,
                message: "Invalid request data."
            }, 400);
        }

        const scope = getScope(
            new URL(context.request.url),
            body
        );

        const validationError = validateScope(scope);

        if (validationError) {
            return json({
                success: false,
                message: validationError
            }, 400);
        }

        /* VALIDATE MAXIMUM MARKS */

        const testMaximum = Number(
            body.overall_test_max
        );

        const examMaximum = Number(
            body.overall_exam_max
        );

        if (!validMaximum(testMaximum)) {
            return json({
                success: false,
                message: "Enter a valid overall test maximum greater than zero."
            }, 400);
        }

        if (!validMaximum(examMaximum)) {
            return json({
                success: false,
                message: "Enter a valid overall examination maximum greater than zero."
            }, 400);
        }

        db = await connectDB(context);

        /* VERIFY TEACHER OWNERSHIP */

        const verified = await verifyTeacherScope(
            db,
            auth,
            scope
        );

        if (verified.error) {
            return json({
                success: false,
                message: verified.error
            }, 403);
        }

        /* SAVE OR UPDATE SETTINGS */

        const result = await db.query(
            `INSERT INTO grading_settings (
                teacher_id,
                school_id,
                class_id,
                subject_id,
                academic_year_id,
                term_id,
                overall_test_max,
                overall_exam_max,
                updated_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())

            ON CONFLICT (
                teacher_id,
                school_id,
                class_id,
                subject_id,
                academic_year_id,
                term_id
            )

            DO UPDATE SET
                overall_test_max = EXCLUDED.overall_test_max,
                overall_exam_max = EXCLUDED.overall_exam_max,
                updated_at = NOW()

            RETURNING
                id,
                overall_test_max,
                overall_exam_max,
                updated_at`,
            [
                verified.teacherId,
                verified.schoolId,
                scope.class_id,
                scope.subject_id,
                scope.academic_year_id,
                scope.term_id,
                testMaximum,
                examMaximum
            ]
        );

        return json({
            success: true,
            message: "Grading settings saved successfully.",
            settings: result.rows[0]
        });

    } catch (error) {

        console.error(
            "SAVE GRADING SETTINGS ERROR:",
            error
        );

        return json({
            success: false,
            message: "Unable to save grading settings."
        }, 500);

    } finally {

        if (db) {
            await db.end().catch(() => {});
        }
    }
}
