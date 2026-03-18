'use strict';

const { Driver } = require('homey');
const VerisureClient = require('../../lib/VerisureClient');

/**
 * ContactSensorDriver
 *
 * Gère la découverte des capteurs Verisure lors du pairing
 * et enregistre les Flow triggers partagés par tous les devices du driver.
 *
 * Flow cards déclarées ici (à déclarer aussi dans app.json) :
 *   triggers : contact_opened, contact_closed
 */
class ContactSensorDriver extends Driver {

  async onInit() {
    this.log('[ContactSensorDriver] Init');

    // Enregistrement des Flow triggers
    // Les instances sont stockées pour être appelées depuis device.js
    this._triggerContactOpened = this.homey.flow.getDeviceTriggerCard('contact_opened');
    this._triggerContactClosed = this.homey.flow.getDeviceTriggerCard('contact_closed');

    this.log('[ContactSensorDriver] Flow triggers enregistrés');
  }

  // ---------------------------------------------------------------------------
  // Helpers Flow — appelés depuis ContactSensorDevice
  // ---------------------------------------------------------------------------

  /**
   * @param {ContactSensorDevice} device
   * @param {{ area: string, device: string }} tokens
   */
  async triggerContactOpened(device, tokens) {
    await this._triggerContactOpened.trigger(device, tokens);
  }

  /**
   * @param {ContactSensorDevice} device
   * @param {{ area: string, device: string }} tokens
   */
  async triggerContactClosed(device, tokens) {
    await this._triggerContactClosed.trigger(device, tokens);
  }

  // ---------------------------------------------------------------------------
  // Pairing
  // ---------------------------------------------------------------------------

  /**
   * Appelé par Homey lors du pairing pour lister les appareils disponibles.
   * La vue pair/start.html gère le login MFA en amont.
   * Cette méthode est appelée depuis pair/list_devices.html.
   */
  async onPairListDevices() {
    this.log('[ContactSensorDriver] Récupération liste capteurs...');

    const client = VerisureClient.fromSettings({ homey: this.homey });
    const sensors = await client.getDoorWindowSensors();

    if (!sensors.length) {
      throw new Error(this.homey.__('error.no_sensors_found'));
    }

    // Récupérer les devices déjà couplés pour les exclure
    const existingLabels = new Set(
      this.getDevices().map(d => d.getSetting('deviceLabel'))
    );

    const newDevices = sensors
      .filter(s => !existingLabels.has(s.deviceLabel))
      .map(sensor => ({
        name: sensor.area || sensor.deviceLabel,
        data: {
          id: sensor.deviceLabel,   // identifiant unique Homey
        },
        settings: {
          deviceLabel: sensor.deviceLabel,
          area: sensor.area || '',
        },
        capabilities: ['alarm_contact', 'alarm_tamper'],
      }));

    this.log(`[ContactSensorDriver] ${newDevices.length} nouveau(x) capteur(s) trouvé(s)`);
    return newDevices;
  }

  // ---------------------------------------------------------------------------
  // Pairing avancé (session MFA)
  // ---------------------------------------------------------------------------

  /**
   * onPair est utilisé pour le flow MFA multi-étapes.
   * Les vues pair/ communiquent via socket.on / socket.emit.
   *
   * Vues utilisées :
   *   start.html        — formulaire email/password + code MFA
   *   list_devices.html — liste des capteurs (Homey built-in)
   */
  onPair(session) {
    let pendingClient = null;

    // Étape 1 : initier le login (déclenche SMS)
    session.setHandler('login_start', async ({ email, password }) => {
      this.log('[ContactSensorDriver] Pairing — login_start');

      const client = new VerisureClient({ homey: this.homey, email, password });
      await client.initiateLogin(email, password);

      // On garde la référence pour l'étape 2
      pendingClient = client;
      return { ok: true };
    });

    // Étape 2 : valider le code MFA
    session.setHandler('login_mfa', async ({ code }) => {
      this.log('[ContactSensorDriver] Pairing — login_mfa');

      if (!pendingClient) {
        throw new Error('login_start doit être appelé avant login_mfa');
      }

      await pendingClient.confirmMfa(code);
      pendingClient = null;

      // Redémarrer le poller avec les nouveaux cookies
      await this.homey.app.poller.restart();

      return { ok: true };
    });

    // Liste des appareils (appelée par list_devices.html)
    session.setHandler('list_devices', async () => {
      return this.onPairListDevices();
    });
  }

}

module.exports = ContactSensorDriver;
