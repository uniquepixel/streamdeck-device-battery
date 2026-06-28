import streamDeck, { LogLevel } from "@elgato/streamdeck";

import { DeviceBatteryAction } from "./actions/device-battery";

// Enable trace logging so all messages between Stream Deck and the plugin are recorded.
streamDeck.logger.setLevel(LogLevel.TRACE);

// Register the battery action.
streamDeck.actions.registerAction(new DeviceBatteryAction());

// Finally, connect to the Stream Deck.
streamDeck.connect();
