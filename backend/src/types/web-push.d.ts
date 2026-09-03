declare module "web-push" {
  type PushSubscription = {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  };

  type PushResponse = { statusCode: number };

  const webpush: {
    setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
    sendNotification(subscription: PushSubscription, payload?: string): Promise<PushResponse>;
  };

  export default webpush;
}

