namespace DbMigrator.Web.Plugins;

// Plugins implementing this interface contribute cards / tabs / scripts to the main UI.
// Discovered automatically via DI scanning at startup.

public class PluginCard
{
    public string Type { get; set; } = "";
    public string Title { get; set; } = "";
    public string Sub { get; set; } = "";
    public string? Port { get; set; }
}

public class PluginTab
{
    public string Id { get; set; } = "";
    public string Label { get; set; } = "";
    public string Html { get; set; } = "";
    public List<string> Scripts { get; set; } = new();
}

public class PluginUiContribution
{
    public List<PluginCard> Cards { get; set; } = new();
    public List<PluginTab> Tabs { get; set; } = new();
    public List<string> Scripts { get; set; } = new();
}

public interface IPluginUiContributor
{
    PluginUiContribution Contribute();
}
