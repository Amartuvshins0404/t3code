import { View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { NavigationRow } from "../../components/ui/NavigationRow";

export function MasterAgentRow(props: { readonly onPress: () => void }) {
  return (
    <View className="mb-2">
      <NavigationRow
        title="Agent"
        leading={<SymbolView name="brain" size={20} tintColorClassName="accent-icon-muted" />}
        onPress={props.onPress}
      />
    </View>
  );
}
