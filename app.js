'use strict';

const { App } = require('homey');
const VerisurePoller = require('./lib/VerisurePoller');

/**
 * VerisureApp
 *
 * Point d'entrée de l'app Homey Verisure France.
 *
 * Responsabilités :
 *   - Instancier et démarrer le VerisurePoller central
 *   - Enregistrer la Flow action "Rafraîchir maintenant"
 *   - Réagir aux changements de settings (intervalle polling)
 *   - Exposer this.poller aux drivers/devices
 */
class VerisureApp extends App {

  // ---------------------------------------------------------------------------
  // Cycle de vie
  // ---------------------------------------------------------------------------

  async onInit() {
    this.log('[VerisureApp] Démarrage — Verisure France');

    // Lecture de l'intervalle depuis les settings app (défaut : 10 min)
    const intervalMin = this.homey.settings.get('poll_interval_min') || 10;
    const intervalMs  = intervalMin * 60 * 1000;

    // Instanciation du poller central — partagé par tous les devices
    this.poller = new VerisurePoller({ homey: this.homey, intervalMs });

    // Enregistrement des Flow actions
    this._registerFlowActions();

    // Démarrage du poller (no-op si pas encore de session enregistrée)
    await this.poller.start();

    // Écoute des changements de settings (intervalle polling)
    this.homey.settings.on('set', key => this._onSettingChanged(key));

    this.log('[VerisureApp] Prêt');
  }

  async onUninit() {
    this.log('[VerisureApp] Arrêt');
    if (this.poller) {
      this.poller.stop();
    }
  }

  // ---------------------------------------------------------------------------
  // Flow actions
  // ---------------------------------------------------------------------------

  _registerFlowActions() {
    // Action : forcer un poll immédiat depuis un Flow Homey
    const refreshAction = this.homey.flow.getActionCard('refresh_now');

    refreshAction.registerRunListener(async () => {
      this.log('[VerisureApp] Flow action — refresh_now déclenché');
      await this.poller.pollNow();
      return true;
    });

    this.log('[VerisureApp] Flow actions enregistrées');
  }

  // ---------------------------------------------------------------------------
  // Réaction aux changements de settings
  // ---------------------------------------------------------------------------

  /**
   * Appelé chaque fois qu'une clé de settings app change.
   * Met à jour l'intervalle du poller à chaud si nécessaire.
   *
   * @param {string} key
   */
  _onSettingChanged(key) {
    if (key === 'poll_interval_min') {
      const intervalMin = this.homey.settings.get('poll_interval_min') || 10;
      const intervalMs  = intervalMin * 60 * 1000;

      this.log(`[VerisureApp] Intervalle polling mis à jour : ${intervalMin} min`);
      this.poller.setInterval(intervalMs);
    }
  }

}

module.exports = VerisureApp;
