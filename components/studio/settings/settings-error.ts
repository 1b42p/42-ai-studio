export const SETTINGS_SAVE_ERROR = "Не удалось сохранить. Попробуйте ещё раз.";

/** Только ошибка валидации API может содержать сообщение для показа пользователю. */
export class SettingsValidationError extends Error {}
