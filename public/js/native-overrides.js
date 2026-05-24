// Native App Overrides for Dream-Analytics

document.addEventListener('DOMContentLoaded', () => {
    // Check if we are running in a native Capacitor environment
    if (window.Capacitor && window.Capacitor.isNative) {
        initializeNativeApp();
    }
});

function initializeNativeApp() {
    console.log("Initializing Native App Overrides...");
    const { App, StatusBar, PushNotifications, SplashScreen } = window.Capacitor.Plugins;

    // 1. Hide Splash Screen after a short delay to ensure UI is ready
    if (SplashScreen) {
        setTimeout(() => {
            SplashScreen.hide();
        }, 1000);
    }

    // 2. Configure Status Bar to match dark theme (#131124)
    if (StatusBar) {
        StatusBar.setBackgroundColor({ color: '#131124' }).catch(err => console.log('StatusBar error', err));
        // Use DARK style for light text
        StatusBar.setStyle({ style: 'DARK' }).catch(err => console.log('StatusBar style error', err));
    }

    // 3. Handle Hardware Back Button
    if (App) {
        App.addListener('backButton', ({ canGoBack }) => {
            // Check if mobile nav is open
            const mobileMenu = document.getElementById('mobile-menu');
            if (mobileMenu && !mobileMenu.classList.contains('hidden')) {
                // Close mobile menu
                const closeBtn = document.getElementById('mobile-menu-btn');
                if (closeBtn) closeBtn.click();
                return;
            }

            // Check if onboarding is open
            const onboardingOverlay = document.getElementById('onboardingOverlay');
            if (onboardingOverlay && !onboardingOverlay.classList.contains('hidden')) {
                if (window.skipOnboarding) window.skipOnboarding();
                return;
            }

            if (canGoBack) {
                window.history.back();
            } else {
                App.exitApp();
            }
        });
    }

    // 4. Setup Push Notifications
    setupPushNotifications(PushNotifications);
}

// Push Notifications logic re-enabled
function setupPushNotifications(PushNotifications) {
    if (!PushNotifications) return;

    // Request permissions
    PushNotifications.requestPermissions().then(result => {
        if (result.receive === 'granted') {
            PushNotifications.register();
        }
    });

    PushNotifications.addListener('registration', (token) => {
        console.log('Push registration success, token: ' + token.value);
        window.nativeFcmToken = token.value;
    });

    PushNotifications.addListener('pushNotificationReceived', (notification) => {
        console.log('Push received: ' + JSON.stringify(notification));
        // Custom event to handle in app if needed, or use global showToast
        const toastEvent = new CustomEvent('app-toast', { detail: { msg: `🔔 ${notification.title || ''} ${notification.body || ''}` } });
        window.dispatchEvent(toastEvent);
    });

    PushNotifications.addListener('pushNotificationActionPerformed', (notification) => {
        console.log('Push action performed: ' + JSON.stringify(notification));
    });
}
