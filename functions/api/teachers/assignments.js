
import {
    connectDB,
    requireSchoolAdmin,
    json
} from "../../_utils.js";

/* =====================================================
   SAVE TEACHER ASSIGNMENT

   SUPPORTS:

   1. BASE-CLASS DEFAULT ASSIGNMENT
      academic_year_id = NULL
      subclass_id      = NULL
      term_id          = NULL

   2. SUBCLASS-SPECIFIC ASSIGNMENT
      academic_year_id = selected academic year
      subclass_id      = selected subclass
      term_id          = NULL

   EXISTING DEFAULT ASSIGNMENTS ARE NEVER MODIFIED.
===================================================== */

export async function onRequestPost(context) {

    // ONLY SCHOOL ADMIN CAN ADD TEACHER ASSIGNMENTS
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

    /* =================================================
       READ REQUEST DATA
    ================================================= */

    const teacherId = Number(data.teacher_id);
    const classId = Number(data.class_id);
    const subjectId = Number(data.subject_id);

    const academicYearValue = data.academic_year_id;
    const subclassValue = data.subclass_id;

    const isSubclassAssignment =
        subclassValue !== undefined &&
        subclassValue !== null &&
        String(subclassValue).trim() !== "";

    const academicYearId =
        academicYearValue !== undefined &&
        academicYearValue !== null &&
        String(academicYearValue).trim() !== ""
            ? Number(academicYearValue)
            : null;

    const subclassId = isSubclassAssignment
        ? Number(subclassValue)
        : null;

    /* =================================================
       VALIDATE REQUIRED IDs
    ================================================= */

    if (
        !Number.isSafeInteger(teacherId) || teacherId <= 0 ||
        !Number.isSafeInteger(classId) || classId <= 0 ||
        !Number.isSafeInteger(subjectId) || subjectId <= 0
    ) {
        return json({
            success: false,
            message: "Please select a valid teacher, class and subject."
        }, 400);
    }

    /* =================================================
       VALIDATE ASSIGNMENT TYPE

       Base-class assignments must not receive an
       academic year or subclass ID.

       Subclass assignments require both IDs.
    ================================================= */

    if (isSubclassAssignment) {

        if (
            !Number.isSafeInteger(subclassId) ||
            subclassId <= 0 ||
            !Number.isSafeInteger(academicYearId) ||
            academicYearId <= 0
        ) {
            return json({
                success: false,
                message: "A valid academic year and subclass are required for a subclass-specific assignment."
            }, 400);
        }

    } else if (academicYearId !== null) {

        return json({
            success: false,
            message: "Select a subclass when assigning a teacher to a specific academic year."
        }, 400);

    }

    let client;

    try {
        client = await connectDB(context);

        /* =================================================
           VALIDATE TEACHER, CLASS, SUBJECT AND PERIOD

           For a default assignment:
           - No academic year is required.
           - No subclass is required.

           For a subclass assignment:
           - Academic year must belong to the school.
           - Subclass must belong to the school.
           - Subclass must belong to the selected year.
           - Subclass must belong to the selected class.
           - Subclass must be active.
        ================================================= */

        const check = await client.query(
            `SELECT
                t.id AS teacher_id,

                c.id AS class_id,
                c.class_name,

                CASE c.level_id
                    WHEN 1 THEN 'Primary'
                    WHEN 2 THEN 'Lower Secondary'
                    WHEN 3 THEN 'Upper Secondary'
                    ELSE 'Unknown'
                END AS class_level,

                s.id AS subject_id,
                s.subject_name,

                ay.id AS academic_year_id,
                ay.year_name AS academic_year_name,

                scs.id AS subclass_id,
                scs.subclass_name

             FROM teachers t

             JOIN users u
               ON u.id = t.user_id
              AND u.school_id = t.school_id
              AND u.role = 'teacher'

             JOIN classes c
               ON c.id = $2

             JOIN school_levels sl
               ON sl.school_id = t.school_id
              AND sl.level_id = c.level_id

             JOIN subjects s
               ON s.id = $3

             JOIN subject_class_levels scl
               ON scl.subject_id = s.id
              AND scl.education_level = CASE c.level_id
                    WHEN 1 THEN 'Primary'
                    WHEN 2 THEN 'Lower Secondary'
                    WHEN 3 THEN 'Upper Secondary'
                    ELSE 'Unknown'
                  END

             LEFT JOIN academic_years ay
               ON ay.id = $5
              AND ay.school_id = t.school_id

             LEFT JOIN school_class_subclasses scs
               ON scs.id = $6
              AND scs.school_id = t.school_id
              AND scs.academic_year_id = ay.id
              AND scs.class_id = c.id
              AND scs.status = 'active'

             WHERE t.id = $1
               AND t.school_id = $4

               AND (
                    (
                        $5::bigint IS NULL
                        AND $6::bigint IS NULL
                    )
                    OR
                    (
                        $5::bigint IS NOT NULL
                        AND $6::bigint IS NOT NULL
                        AND ay.id IS NOT NULL
                        AND scs.id IS NOT NULL
                    )
               )

             LIMIT 1`,
            [
                teacherId,
                classId,
                subjectId,
                auth.schoolId,
                academicYearId,
                subclassId
            ]
        );

        if (check.rowCount === 0) {

            return json({
                success: false,
                message: isSubclassAssignment
                    ? "Invalid assignment. Check the teacher, class, subject, academic year and subclass. The subclass must be active and belong to the selected class and academic year."
                    : "Invalid assignment. Check the teacher, class and subject. The subject may not be available for this class level."
            }, 400);

        }

        const assignmentDetails = check.rows[0];

        /* =================================================
           SAVE ASSIGNMENT

           Existing expression-based unique index:

           (
             teacher_id,
             school_id,
             class_id,
             subject_id,
             COALESCE(academic_year_id, 0),
             COALESCE(subclass_id, 0)
           )

           DO NOTHING prevents duplicate assignments.

           IMPORTANT:
           - Existing default assignments are untouched.
           - Subclass assignments are stored separately.
           - term_id remains NULL because the assignment
             is scoped to the academic year, not a term.
        ================================================= */

        const insertResult = await client.query(
            `INSERT INTO teacher_assignments (
                school_id,
                teacher_id,
                class_id,
                subject_id,
                academic_year_id,
                term_id,
                subclass_id
             )
             VALUES (
                $1,
                $2,
                $3,
                $4,
                $5,
                NULL,
                $6
             )
             ON CONFLICT (
                teacher_id,
                school_id,
                class_id,
                subject_id,
                (COALESCE(academic_year_id, 0::bigint)),
                (COALESCE(subclass_id, 0::bigint))
             )
             DO NOTHING
             RETURNING id`,
            [
                auth.schoolId,
                teacherId,
                classId,
                subjectId,
                academicYearId,
                subclassId
            ]
        );

        /* =================================================
           RESPONSE
        ================================================= */

        if (insertResult.rowCount === 0) {

            return json({
                success: true,
                already_exists: true,
                message: "This teacher is already assigned to this subject and class/subclass.",
                assignment: {
                    teacher_id: teacherId,
                    class_id: classId,
                    class_name: assignmentDetails.class_name,
                    subject_id: subjectId,
                    subject_name: assignmentDetails.subject_name,
                    academic_year_id: academicYearId,
                    academic_year_name:
                        assignmentDetails.academic_year_name,
                    subclass_id: subclassId,
                    subclass_name:
                        assignmentDetails.subclass_name,
                    assignment_type: isSubclassAssignment
                        ? "subclass"
                        : "default"
                }
            });

        }

        return json({
            success: true,
            already_exists: false,
            message: isSubclassAssignment
                ? "Teacher assigned to the subclass successfully."
                : "Teaching assignment saved successfully.",
            assignment: {
                assignment_id: insertResult.rows[0].id,
                teacher_id: teacherId,
                class_id: classId,
                class_name: assignmentDetails.class_name,
                subject_id: subjectId,
                subject_name: assignmentDetails.subject_name,
                academic_year_id: academicYearId,
                academic_year_name:
                    assignmentDetails.academic_year_name,
                subclass_id: subclassId,
                subclass_name:
                    assignmentDetails.subclass_name,
                assignment_type: isSubclassAssignment
                    ? "subclass"
                    : "default"
            }
        });

    } catch (error) {

        console.error("SAVE TEACHER ASSIGNMENT ERROR:", {
            message: error?.message,
            code: error?.code,
            detail: error?.detail,
            constraint: error?.constraint,
            table: error?.table,
            column: error?.column,
            stack: error?.stack
        });

        return json({
            success: false,
            message: "Could not save the teaching assignment.",
            debug: {
                error: error?.message,
                code: error?.code,
                detail: error?.detail,
                constraint: error?.constraint
            }
        }, 500);

    } finally {

        if (client) {
            await client.end().catch(() => {});
        }

    }
}
