export { loadSmtpConfig, type SmtpConfig } from "./config.ts";
export {
  DeliveryError,
  type DeliveryFailureCode,
  type NotificationEmail,
  sendSmtpEmail,
} from "./smtp.ts";
export {
  createNotificationService,
  type NotificationResult,
  type NotificationService,
  type NotificationSettings,
  notificationSettingsSchema,
  type NotificationState,
} from "./service.ts";
export {
  createNotificationDeliveryLoop,
  deliveryRetry,
  NOTIFICATION_RETRY_DELAYS_MS,
} from "./delivery.ts";
