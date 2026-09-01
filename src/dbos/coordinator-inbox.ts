type ReceiveCoordinatorMessage<Message> = () => Promise<Message | null>;

/** Treats DBOS receive-window expiry as continued waiting, not workflow failure. */
export const waitForCoordinatorMessage = async <Message>(
  receive: ReceiveCoordinatorMessage<Message>,
): Promise<Message> => {
  while (true) {
    // oxlint-disable-next-line no-await-in-loop -- receive windows must preserve inbox order.
    const message = await receive();
    if (message !== null) {
      return message;
    }
  }
};
