Polling & session
Arborescence du projet
	com.verisure.homey/
	app.json config — manifest : id, permissions, drivers déclarés
	app.js entrée — init app, démarrage VerisureService
package.json
— dépendances : verisure, node-fetch
lib/
	VerisureClient.js clé — wrapper API verisure + adaptation endpoint FR
	VerisureSession.js nouveau — gestion token, refresh, expiration
	VerisurePoller.js — polling toutes les 10 min, émission events
drivers/
	contact-sensor/
	driver.js — découverte appareils, onPairListDevices
	device.js clé — capability alarm_contact, sync état
	pair/
		start.html 		   — login + saisie MFA
		list_devices.html  — liste capteurs détectés
	alarm-panel/
		driver.js          — centrale alarme (1 seul device)
		device.js		   — capability homealarm_state
settings/
	index.html — intervalle polling, infos session
locales/
	fr.json
	en.json
	
	
	com.verisure.homey/
├─ assets/images/
│   ├─ small.png    ← app-small.png
│   ├─ large.png    ← app-large.png
│   └─ xlarge.png   ← app-xlarge.png
├─ drivers/
│   ├─ contact-sensor/assets/images/
│   │   ├─ small.png    ← contact-sensor-small.png
│   │   ├─ large.png    ← contact-sensor-large.png
│   │   └─ xlarge.png   ← contact-sensor-xlarge.png
│   └─ alarm-panel/assets/images/
│       ├─ small.png    ← alarm-panel-small.png
│       ├─ large.png    ← alarm-panel-large.png
│       └─ xlarge.png   ← alarm-panel-xlarge.png