'use strict';

const { Driver } = require('homey');
const VerisureClient = require('../../lib/VerisureClient');

/**
 * AlarmPanelDriver
 *
 * Driver de la centrale d'alarme Verisure.
 * Une seule installation = un seul device (pas de liste multiple).
 *
 * Le pairing est simplifié : pas de nouvelle authentification requise
 * (la session a déjà été ouverte par le contact-sensor driver).
 * On liste directement l'installation disponible.
 */
class AlarmPanelDriver extends Driver {

  async onInit() {
    this.log('[AlarmPanelDriver] Init');

    // Flow trigger : alarme déclenchée
    this._triggerAlarmTriggered = this.homey.flow.getDeviceTriggerCard('alarm_triggered');

    this.log('[AlarmPanelDriver] Flow triggers enregistrés');
  }

  // ---------------------------------------------------------------------------
  // Helper Flow — appelé depuis AlarmPanelDevice
  // ---------------------------------------------------------------------------

  /**
   * @param {AlarmPanelDevice} device
   * @param {{ state: string, changed_via: string }} tokens
   */
  async triggerAlarmTriggered(device, tokens) {
    await this._triggerAlarmTriggered.trigger(device, tokens);
  }

  // ---------------------------------------------------------------------------
  // Pairing
  // ---------------------------------------------------------------------------

  /**
   * Liste les panneaux d'alarme disponibles (une installation = une centrale).
   * Requiert une session Verisure déjà enregistrée dans Homey settings.
   */
  async onPairListDevices() {
    this.log('[AlarmPanelDriver] Récupération installation...');

    const client = VerisureClient.fromSettings({ homey: this.homey });

    // Vérification qu'il n'y a pas déjà un panneau couplé
    const existing = this.getDevices();
    if (existing.length > 0) {
      this.log('[AlarmPanelDriver] Centrale déjà couplée — aucun nouvel appareil');
      return [];
    }

    // On récupère l'état alarme pour valider la connexion et obtenir le giid
    const armState = await client.getArmState();

    if (!armState) {
      throw new Error(this.homey.__('error.no_installation_found'));
    }

    return [
      {
        name: this.homey.__('device.alarm_panel_name') || 'Verisure Alarm Panel',
        data: {
          id: 'alarm-panel-main',
        },
        settings: {
          giid: armState.giid || '',
        },
        capabilities: ['homealarm_state', 'alarm_generic'],
      },
    ];
  }

  onPair(session) {
    session.setHandler('list_devices', async () => {
      return this.onPairListDevices();
    });
  }

}

module.exports = AlarmPanelDriver;
