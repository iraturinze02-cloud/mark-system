
import {
    connectDB,
    requireTestUser,
    json
} from "../../_utils.js";

/* =====================================================
   HELPERS
===================================================== */

function uniqueIds(values) {
    if (!Array.isArray(values)) return [];

    return [
        ...new Set(
            values
                .map(value => String(value).trim())
                .filter(value => /^\d+$/.test(value))
        )
    ];
}

function validClosingAt(value) {
    if (value === null || value === undefined || value === "") {
        return null;
    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
        return undefined;
    }

    if (date.getTime() <= Date.now()) {
        return undefined;
    }

    return date.toISOString();
}

function getValue(data, snakeCase, camelCase) {
    return data[snakeCase] ?? data[camelCase];
}

/* =====================================================
   VALIDATE SUBJECT MAXIMUM MARKS
===================================================== */

function validateSubjectMarks(subjectIds, subjectMarks) {
    if (!Array.isArray(subjectMarks)) {
        return {
            valid: false,
            message: "Provide maximum marks for every selected subject."
        };
    }

    if (subjectMarks.length !== subjectIds.length) {
        return {
            valid: false,
            message: "Provide maximum marks for every selected subject."
        };
    }

    const marksMap = new Map();

    for (const item of subjectMarks) {
        if (!item || typeof item !== "object") {
            return {
                valid: false,
                message: "Invalid subject maximum marks data."
            };
        }

        const subjectId = String(
            item.subject_id ?? item.subjectId ?? ""
        ).trim();

        const totalMarks = Number(
            item.total_marks ?? item.totalMarks
        );

        if (!/^\d+$/.test(subjectId)) {
            return {
                valid: false,
                message: "Invalid subject selected."
            };
        }

        if (!subjectIds.includes(subjectId)) {
            return {
                valid: false,
                message: "Maximum marks were provided for an unselected subject."
            };
        }

        if (marksMap.has(subjectId)) {
            return {
                valid: false,
                message: "Duplicate subject maximum marks were provided."
            };
        }

        if (
            !Number.isFinite(totalMarks) ||
            totalMarks <= 0
        ) {
            return {
                valid: false,
                message: "Every subject must have a positive maximum mark."
            };
        }

        marksMap.set(subjectId, totalMarks);
    }

    for (const subjectId of subjectIds) {
        if (!marksMap.has(subjectId)) {
            return {
                valid: false,
                message: "Provide maximum marks for every selected subject."
            };
        }
    }

    return {
        valid: true,
        marks: subjectIds.map(subjectId => ({
            subject_id: subjectId,
            total_marks: marksMap.get(subjectId)
        }))
    };
}

/* =====================================================
   LOAD ACTIVE PERIODS FOR NEW SCHOOLS
===================================================== */

async function loadActiveSchoolPeriods(client, schoolIds) {
    if (!schoolIds.length) {
        return new Map();
    }

    const result = await client.query(
        `
        SELECT
            ay.school_id,
            ay.id AS academic_year_id,
            ay.year_name,

            t.id AS term_id,
            t.term_name,
            t.term_number

        FROM academic_years ay

        INNER JOIN terms t
            ON t.academic_year_id = ay.id
           AND t.school_id = ay.school_id

        WHERE ay.school_id = ANY($1::bigint[])

          AND (NOW() AT TIME ZONE 'Africa/Kigali')::date
              BETWEEN ay.start_date AND ay.end_date

          AND (NOW() AT TIME ZONE 'Africa/Kigali')::date
              BETWEEN t.start_date AND t.end_date

        ORDER BY ay.school_id
        `,
        [schoolIds]
    );

    const periodsBySchool = new Map();

    for (const period of result.rows) {
        const schoolId = String(period.school_id);

        if (!periodsBySchool.has(schoolId)) {
            periodsBySchool.set(schoolId, []);
        }

        periodsBySchool.get(schoolId).push(period);
    }

    return periodsBySchool;
}

/* =====================================================
   LOAD PERIODS USING THE ORIGINAL TEST CREATION DATE

   Used only for older test_schools records whose
   academic_year_id and term_id are still NULL.

   This avoids incorrectly assigning today's period
   to an older test.
===================================================== */

async function loadPeriodsAtTestCreation(
    client,
    schoolIds,
    testCreatedAt
) {
    if (!schoolIds.length) {
        return new Map();
    }

    const result = await client.query(
        `
        SELECT
            ay.school_id,
            ay.id AS academic_year_id,
            ay.year_name,

            t.id AS term_id,
            t.term_name,
            t.term_number

        FROM academic_years ay

        INNER JOIN terms t
            ON t.academic_year_id = ay.id
           AND t.school_id = ay.school_id

        WHERE ay.school_id = ANY($1::bigint[])

          AND $2::timestamptz IS NOT NULL

          AND ($2::timestamptz AT TIME ZONE 'Africa/Kigali')::date
              BETWEEN ay.start_date AND ay.end_date

          AND ($2::timestamptz AT TIME ZONE 'Africa/Kigali')::date
              BETWEEN t.start_date AND t.end_date

        ORDER BY ay.school_id
        `,
        [
            schoolIds,
            testCreatedAt
        ]
    );

    const periodsBySchool = new Map();

    for (const period of result.rows) {
        const schoolId = String(period.school_id);

        if (!periodsBySchool.has(schoolId)) {
            periodsBySchool.set(schoolId, []);
        }

        periodsBySchool.get(schoolId).push(period);
    }

    return periodsBySchool;
}

/* =====================================================
   POST: TEST ACTIONS

   Supported actions:
   - update
   - initiate
   - close
   - delete

   Sector admin:
   Manages tests belonging to their sector.

   School admin and DOS:
   Manage tests belonging to their school.
===================================================== */

export async function onRequestPost(context) {
    const auth = await requireTestUser(context);

    if (auth.error) {
        return auth.error;
    }

    if (
        !["sector_admin", "school_admin", "dos"].includes(auth.role)
    ) {
        return json({
            success: false,
            message: "You are not allowed to manage tests."
        }, 403);
    }

    let data;

    try {
        data = await context.request.json();
    } catch {
        return json({
            success: false,
            message: "Invalid JSON request."
        }, 400);
    }

    const action = String(data.action || "").trim();

    const testId = String(
        data.testId ?? data.test_id ?? ""
    ).trim();

    if (!/^\d+$/.test(testId)) {
        return json({
            success: false,
            message: "Invalid test ID."
        }, 400);
    }

    const allowedActions = [
        "update",
        "initiate",
        "close",
        "delete"
    ];

    if (!allowedActions.includes(action)) {
        return json({
            success: false,
            message: "Invalid test action."
        }, 400);
    }

    let client;
    let transactionStarted = false;

    try {
        client = await connectDB(context);

        await client.query("BEGIN");
        transactionStarted = true;

        /* ---------------------------------------------
           FIND AND LOCK TEST

           Authorization is based on organizational
           scope, not on who created the test.
        --------------------------------------------- */

        let testResult;

        if (auth.role === "sector_admin") {
            testResult = await client.query(
                `
                SELECT *
                FROM tests
                WHERE id = $1
                  AND sector_id = $2
                FOR UPDATE
                `,
                [
                    testId,
                    auth.sectorId
                ]
            );
        } else {
            testResult = await client.query(
                `
                SELECT *
                FROM tests
                WHERE id = $1
                  AND school_id = $2
                FOR UPDATE
                `,
                [
                    testId,
                    auth.schoolId
                ]
            );
        }

        if (testResult.rows.length === 0) {
            await client.query("ROLLBACK");
            transactionStarted = false;

            return json({
                success: false,
                message: "Test not found or you do not have permission to manage it."
            }, 404);
        }

        const test = testResult.rows[0];

        /* ---------------------------------------------
           DELETE TEST

           Only draft tests can be deleted.
        --------------------------------------------- */

        if (action === "delete") {
            if (test.status !== "draft") {
                await client.query("ROLLBACK");
                transactionStarted = false;

                return json({
                    success: false,
                    message: "Only draft tests can be deleted."
                }, 400);
            }

            const mappingResult = await client.query(
                `
                SELECT 1
                FROM test_examinations
                WHERE test_id = $1
                LIMIT 1
                `,
                [testId]
            );

            if (mappingResult.rows.length > 0) {
                await client.query("ROLLBACK");
                transactionStarted = false;

                return json({
                    success: false,
                    message: "This test is linked to an examination and cannot be deleted."
                }, 409);
            }

            await client.query(
                `
                DELETE FROM tests
                WHERE id = $1
                `,
                [testId]
            );

            await client.query("COMMIT");
            transactionStarted = false;

            return json({
                success: true,
                message: "Test deleted successfully."
            });
        }

        /* ---------------------------------------------
           INITIATE TEST

           Only draft tests can be initiated.
        --------------------------------------------- */

        if (action === "initiate") {
            if (test.status !== "draft") {
                await client.query("ROLLBACK");
                transactionStarted = false;

                return json({
                    success: false,
                    message: "Only draft tests can be initiated."
                }, 400);
            }

            if (
                test.closing_at &&
                new Date(test.closing_at).getTime() <= Date.now()
            ) {
                await client.query("ROLLBACK");
                transactionStarted = false;

                return json({
                    success: false,
                    message: "The test closing time has already passed."
                }, 400);
            }

            await client.query(
                `
                UPDATE tests
                SET
                    status = 'open',
                    initiated_at = NOW(),
                    initiated_by = $2,
                    closed_at = NULL,
                    closed_by = NULL,
                    updated_at = NOW()
                WHERE id = $1
                `,
                [
                    testId,
                    auth.userId
                ]
            );

            await client.query("COMMIT");
            transactionStarted = false;

            return json({
                success: true,
                message: "Test initiated successfully. Teachers can now record marks.",
                initiated_by: auth.userId
            });
        }

        /* ---------------------------------------------
           CLOSE TEST
        --------------------------------------------- */

        if (action === "close") {
            if (test.status !== "open") {
                await client.query("ROLLBACK");
                transactionStarted = false;

                return json({
                    success: false,
                    message: "Only open tests can be closed."
                }, 400);
            }

            await client.query(
                `
                UPDATE tests
                SET
                    status = 'closed',
                    closed_at = NOW(),
                    closed_by = $2,
                    updated_at = NOW()
                WHERE id = $1
                `,
                [
                    testId,
                    auth.userId
                ]
            );

            await client.query("COMMIT");
            transactionStarted = false;

            return json({
                success: true,
                message: "Test closed successfully.",
                closed_by: auth.userId
            });
        }

        /* ---------------------------------------------
           UPDATE TEST

           Only draft tests can be edited.
        --------------------------------------------- */

        if (action === "update") {
            if (test.status !== "draft") {
                await client.query("ROLLBACK");
                transactionStarted = false;

                return json({
                    success: false,
                    message: "Only draft tests can be edited."
                }, 400);
            }

            /* -----------------------------------------
               READ TEST DETAILS
            ----------------------------------------- */

            const testName = String(
                getValue(data, "test_name", "testName") || ""
            ).trim();

            if (!testName || testName.length > 200) {
                await client.query("ROLLBACK");
                transactionStarted = false;

                return json({
                    success: false,
                    message: "Enter a valid test name."
                }, 400);
            }

            let schoolIds = uniqueIds(
                getValue(data, "school_ids", "schoolIds")
            );

            const classIds = uniqueIds(
                getValue(data, "class_ids", "classIds")
            );

            const subjectIds = uniqueIds(
                getValue(data, "subject_ids", "subjectIds")
            );

            // School Admin and DOS can only manage
            // their own school's tests.
            if (
                auth.role === "school_admin" ||
                auth.role === "dos"
            ) {
                schoolIds = [String(auth.schoolId)];
            }

            if (
                schoolIds.length === 0 ||
                classIds.length === 0 ||
                subjectIds.length === 0
            ) {
                await client.query("ROLLBACK");
                transactionStarted = false;

                return json({
                    success: false,
                    message: "Select at least one school, class and subject."
                }, 400);
            }

            /* -----------------------------------------
               VALIDATE SUBJECT MAXIMUM MARKS
            ----------------------------------------- */

            const subjectMarksValidation = validateSubjectMarks(
                subjectIds,
                getValue(data, "subject_marks", "subjectMarks")
            );

            if (!subjectMarksValidation.valid) {
                await client.query("ROLLBACK");
                transactionStarted = false;

                return json({
                    success: false,
                    message: subjectMarksValidation.message
                }, 400);
            }

            const subjectMarks = subjectMarksValidation.marks;

            /* -----------------------------------------
               VALIDATE CLOSING DATE
            ----------------------------------------- */

            const closingAt = validClosingAt(
                getValue(data, "closing_at", "closingAt")
            );

            if (closingAt === undefined) {
                await client.query("ROLLBACK");
                transactionStarted = false;

                return json({
                    success: false,
                    message: "The closing date and time must be in the future."
                }, 400);
            }

            /* -----------------------------------------
               VALIDATE SCHOOLS
            ----------------------------------------- */

            let validSchools;

            if (auth.role === "sector_admin") {
                validSchools = await client.query(
                    `
                    SELECT id
                    FROM schools
                    WHERE id = ANY($1::bigint[])
                      AND sector_id = $2
                      AND status = 'active'
                    `,
                    [
                        schoolIds,
                        auth.sectorId
                    ]
                );
            } else {
                validSchools = await client.query(
                    `
                    SELECT id
                    FROM schools
                    WHERE id = $1
                      AND status = 'active'
                    `,
                    [auth.schoolId]
                );
            }

            if (validSchools.rows.length !== schoolIds.length) {
                await client.query("ROLLBACK");
                transactionStarted = false;

                return json({
                    success: false,
                    message: "One or more selected schools are invalid."
                }, 400);
            }

            /* -----------------------------------------
               VALIDATE CLASSES USING UNIVERSAL CLASSES

               A school offers a class when:
               school_levels.school_id = selected school
               school_levels.level_id = classes.level_id
            ----------------------------------------- */

            const validClasses = await client.query(
                `
                SELECT
                    c.id,
                    c.class_name,
                    c.level_id,
                    sl.school_id

                FROM classes c

                INNER JOIN school_levels sl
                    ON sl.level_id = c.level_id

                WHERE c.id = ANY($1::bigint[])
                  AND sl.school_id = ANY($2::bigint[])

                ORDER BY
                    sl.school_id,
                    c.class_name
                `,
                [
                    classIds,
                    schoolIds
                ]
            );

            /* -----------------------------------------
               CONFIRM EVERY SELECTED CLASS IS OFFERED
               BY AT LEAST ONE SELECTED SCHOOL
            ----------------------------------------- */

            const validClassIds = new Set(
                validClasses.rows.map(row => String(row.id))
            );

            const missingClassIds = classIds.filter(
                id => !validClassIds.has(id)
            );

            if (missingClassIds.length > 0) {
                await client.query("ROLLBACK");
                transactionStarted = false;

                return json({
                    success: false,
                    message: "One or more selected classes are not offered by the selected schools."
                }, 400);
            }

            /* -----------------------------------------
               VALIDATE SUBJECTS
            ----------------------------------------- */

            const validSubjects = await client.query(
                `
                SELECT id
                FROM subjects
                WHERE id = ANY($1::bigint[])
                `,
                [subjectIds]
            );

            if (validSubjects.rows.length !== subjectIds.length) {
                await client.query("ROLLBACK");
                transactionStarted = false;

                return json({
                    success: false,
                    message: "One or more selected subjects are invalid."
                }, 400);
            }

            /* -----------------------------------------
               LOAD EXISTING SCHOOL PERIOD ASSIGNMENTS

               Existing mappings must be preserved.
            ----------------------------------------- */

            const existingPeriodsResult = await client.query(
                `
                SELECT
                    school_id,
                    academic_year_id,
                    term_id
                FROM test_schools
                WHERE test_id = $1
                `,
                [testId]
            );

            const existingPeriods = new Map(
                existingPeriodsResult.rows.map(row => [
                    String(row.school_id),
                    row
                ])
            );

            /* -----------------------------------------
               IDENTIFY SCHOOLS NEEDING A PERIOD

               Existing complete mappings are preserved.

               Existing NULL mappings are resolved using
               the original test creation date.

               New schools use the currently active period.
            ----------------------------------------- */

            const schoolsNeedingOriginalPeriod = [];
            const schoolsNeedingCurrentPeriod = [];

            for (const schoolId of schoolIds) {
                const existing = existingPeriods.get(schoolId);

                if (
                    existing &&
                    existing.academic_year_id !== null &&
                    existing.term_id !== null
                ) {
                    continue;
                }

                if (existing) {
                    schoolsNeedingOriginalPeriod.push(schoolId);
                } else {
                    schoolsNeedingCurrentPeriod.push(schoolId);
                }
            }

            /* -----------------------------------------
               LOAD ORIGINAL PERIOD FOR OLDER MAPPINGS
            ----------------------------------------- */

            const originalPeriods = await loadPeriodsAtTestCreation(
                client,
                schoolsNeedingOriginalPeriod,
                test.created_at
            );

            /* -----------------------------------------
               LOAD CURRENT PERIOD FOR NEW SCHOOLS
            ----------------------------------------- */

            const currentPeriods = await loadActiveSchoolPeriods(
                client,
                schoolsNeedingCurrentPeriod
            );

            /* -----------------------------------------
               BUILD FINAL SCHOOL PERIOD MAP
            ----------------------------------------- */

            const schoolAcademicPeriods = new Map();
            const invalidPeriodSchools = [];

            for (const schoolId of schoolIds) {
                const existing = existingPeriods.get(schoolId);

                // Preserve complete existing mappings.
                if (
                    existing &&
                    existing.academic_year_id !== null &&
                    existing.term_id !== null
                ) {
                    schoolAcademicPeriods.set(schoolId, {
                        academic_year_id: existing.academic_year_id,
                        term_id: existing.term_id
                    });

                    continue;
                }

                // Older mapping with NULL period:
                // resolve using the test creation date.
                if (existing) {
                    const matchingPeriods =
                        originalPeriods.get(schoolId) || [];

                    if (matchingPeriods.length === 1) {
                        schoolAcademicPeriods.set(schoolId, {
                            academic_year_id:
                                matchingPeriods[0].academic_year_id,
                            term_id:
                                matchingPeriods[0].term_id
                        });
                    } else {
                        const school = schoolsForPeriodError(
                            schoolId,
                            schoolIds,
                            validSchools.rows
                        );

                        invalidPeriodSchools.push(
                            school || `School ID ${schoolId}`
                        );
                    }

                    continue;
                }

                // Newly added school:
                // use its currently active academic period.
                const matchingPeriods =
                    currentPeriods.get(schoolId) || [];

                if (matchingPeriods.length === 1) {
                    schoolAcademicPeriods.set(schoolId, {
                        academic_year_id:
                            matchingPeriods[0].academic_year_id,
                        term_id:
                            matchingPeriods[0].term_id
                    });
                } else {
                    invalidPeriodSchools.push(
                        `School ID ${schoolId}`
                    );
                }
            }

            if (invalidPeriodSchools.length > 0) {
                await client.query("ROLLBACK");
                transactionStarted = false;

                return json({
                    success: false,
                    message:
                        "Unable to update the test because an exact academic year and term could not be identified for: " +
                        invalidPeriodSchools.join(", ") +
                        ". No changes were saved."
                }, 409);
            }

            /* -----------------------------------------
               UPDATE MAIN TEST
            ----------------------------------------- */

            await client.query(
                `
                UPDATE tests
                SET
                    test_name = $1,
                    closing_at = $2,
                    updated_at = NOW()
                WHERE id = $3
                `,
                [
                    testName,
                    closingAt,
                    testId
                ]
            );

            /* -----------------------------------------
               REMOVE OLD CLASS RELATIONSHIPS

               Delete test_classes before removing
               any school mappings.
            ----------------------------------------- */

            await client.query(
                `
                DELETE FROM test_classes
                WHERE test_id = $1
                `,
                [testId]
            );

            /* -----------------------------------------
               REMOVE ONLY SCHOOLS NO LONGER SELECTED

               Retained school mappings are preserved.
            ----------------------------------------- */

            await client.query(
                `
                DELETE FROM test_schools
                WHERE test_id = $1
                  AND NOT (school_id = ANY($2::bigint[]))
                `,
                [
                    testId,
                    schoolIds
                ]
            );

            /* -----------------------------------------
               INSERT OR PRESERVE SCHOOL MAPPINGS

               Existing schools retain their original
               academic year and term.

               New schools receive their active period.
            ----------------------------------------- */

            for (const schoolId of schoolIds) {
                const period = schoolAcademicPeriods.get(schoolId);

                await client.query(
                    `
                    INSERT INTO test_schools (
                        test_id,
                        school_id,
                        academic_year_id,
                        term_id
                    )
                    VALUES ($1, $2, $3, $4)

                    ON CONFLICT (test_id, school_id)
                    DO UPDATE SET
                        academic_year_id = EXCLUDED.academic_year_id,
                        term_id = EXCLUDED.term_id
                    `,
                    [
                        testId,
                        schoolId,
                        period.academic_year_id,
                        period.term_id
                    ]
                );
            }

            /* -----------------------------------------
               INSERT SCHOOL/CLASS COMBINATIONS

               A selected class is linked to every
               selected school offering that class.
            ----------------------------------------- */

            for (const selectedClass of validClasses.rows) {
                await client.query(
                    `
                    INSERT INTO test_classes (
                        test_id,
                        school_id,
                        class_id
                    )
                    VALUES ($1, $2, $3)
                    `,
                    [
                        testId,
                        selectedClass.school_id,
                        selectedClass.id
                    ]
                );
            }

            /* -----------------------------------------
               UPDATE SUBJECT RELATIONSHIPS
            ----------------------------------------- */

            await client.query(
                `
                DELETE FROM test_subjects
                WHERE test_id = $1
                `,
                [testId]
            );

            for (const subject of subjectMarks) {
                await client.query(
                    `
                    INSERT INTO test_subjects (
                        test_id,
                        subject_id,
                        total_marks
                    )
                    VALUES ($1, $2, $3)
                    `,
                    [
                        testId,
                        subject.subject_id,
                        subject.total_marks
                    ]
                );
            }

            await client.query("COMMIT");
            transactionStarted = false;

            return json({
                success: true,
                message: "Test updated successfully."
            });
        }

    } catch (error) {
        if (client && transactionStarted) {
            await client.query("ROLLBACK").catch(() => {});
        }

        console.error("Test action error:", error);

        return json({
            success: false,
            message: "Unable to complete the requested test action."
        }, 500);

    } finally {
        if (client) {
            await client.end().catch(() => {});
        }
    }
}

/* =====================================================
   HELPER: SCHOOL NAME FOR PERIOD ERROR
===================================================== */

function schoolsForPeriodError(schoolId, schoolIds, validSchools) {
    // The validated school rows contain IDs only.
    // Return a clear identifier when the name is not
    // available in this endpoint.
    return `School ID ${schoolId}`;
}
