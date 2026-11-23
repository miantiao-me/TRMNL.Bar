# TRMNL.Bar Design

Metrix.Bar displays a TRMNL server's rendered screen in a native panel and desktop widget. Put connection status, pairing details, refresh, and disconnect actions in the tray menu. Use the host dashboard settings for the server URL, credentials, and mode. English is the fallback, and Simplified Chinese follows the host language.

Device mode enrolls a virtual TRMNL device and follows its server playlist. Mirror mode fetches the current screen of an existing device without advancing the playlist. The TRMNL server renders the screen. The Worker handles protocol, credentials, refresh, and native image loading.

Keep the last successful frame during a failed refresh. Retry an unfinished frame download before asking the server for the next screen. Persist disconnect intent and clear credentials and frame state so restart cannot silently reconnect. Keep credentials in host secrets and bind checkpoints to the device and server.
