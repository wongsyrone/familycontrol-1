# SPDX-License-Identifier: GPL-3.0-or-later

include $(TOPDIR)/rules.mk

LUCI_TITLE:=Mobile-first family internet controls
LUCI_DEPENDS:=+luci-base +firewall4 +rpcd-mod-ucode +ucode-mod-uci +ucode-mod-fs +ucode-mod-ubus +ip +wget-ssl
LUCI_PKGARCH:=all

PKG_VERSION:=0.1.0
PKG_RELEASE:=21
PKG_LICENSE:=GPL-3.0-or-later

define Package/luci-app-familycontrol/conffiles
/etc/config/familycontrol
/etc/config/familycontrol_telemetry
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
