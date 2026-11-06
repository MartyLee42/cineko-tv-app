// App-wide singletons for post-watch prompts and admin messages.
import { storage } from "../platform";
import { MessageQueue } from "../messages/queue";
import { RatingQueue } from "./rating";

export const ratingQueue = new RatingQueue(storage);
export const messageQueue = new MessageQueue();
