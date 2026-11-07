import type { FieldValues, Path, UseFormSetError } from 'react-hook-form';
import { toast } from 'sonner';
import { ApiError } from './api';

/** Show server-side validation errors next to fields; other errors as a toast. */
export function handleFormError<T extends FieldValues>(err: unknown, setError?: UseFormSetError<T>) {
  if (err instanceof ApiError) {
    const entries = Object.entries(err.fields);
    if (setError && entries.length) {
      for (const [field, message] of entries) setError(field as Path<T>, { message });
      return;
    }
    toast.error(err.message);
    return;
  }
  toast.error('Something went wrong. Please try again.');
}
