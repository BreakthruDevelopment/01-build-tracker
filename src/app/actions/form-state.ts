/** Result of an admin form. Strings only, so it can cross to the browser. */
export type FormState = { error: string | null; message: string | null };

export const emptyFormState: FormState = { error: null, message: null };
